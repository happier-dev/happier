import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import {
    resolveConnectedServiceDisplayName,
    resolveQualifiedConnectedServiceRegistryDisplayName,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import type {
    SessionConnectedServiceAuthSwitchResult,
    SessionConnectedServiceAuthSwitchServiceResult,
} from '@/sync/ops/connectedServices/sessionAuthSwitch';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol';

type PartialAuthSwitchServiceStatus = Extract<
    SessionConnectedServiceAuthSwitchServiceResult['status'],
    'failed' | 'not_attempted'
>;

type PartialAuthSwitchServiceNotice = Readonly<{
    serviceId: string;
    status: PartialAuthSwitchServiceStatus;
}>;

type PartialAuthSwitchServiceStatusLabelKey =
    | 'connectedServices.authSwitch.status.partialApplicationServiceFailed'
    | 'connectedServices.authSwitch.status.partialApplicationServiceNotApplied';

type ConnectedServicesBindingMap = Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;

/**
 * Reconcile context captured at the moment a partial hot-apply failed. The
 * session-scope Retry/Revert affordance (the mirror of the pool-level
 * divergence surface) re-applies against these binding sets through the ONE
 * canonical apply path — never a parallel apply.
 */
export type PartialAuthSwitchReconcileContext = Readonly<{
    /** The service the user switched — Retry/Revert re-applies against it. */
    primaryServiceId: string;
    /** Full binding-set that was attempted (Retry re-converges on the target). */
    attemptedBindingsByServiceId: ConnectedServicesBindingMap;
    /** Full binding-set before the switch (Revert re-converges on the previous account). */
    previousBindingsByServiceId: ConnectedServicesBindingMap;
}>;

export type PartialAuthSwitchApplicationNotice =
    | Readonly<{ kind: 'generic' } & PartialAuthSwitchReconcileContext>
    | Readonly<{
        kind: 'services';
        services: ReadonlyArray<PartialAuthSwitchServiceNotice>;
      } & PartialAuthSwitchReconcileContext>;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function hasPartialAuthSwitchApplication(
    result: SessionConnectedServiceAuthSwitchResult,
): boolean {
    if (result.ok) return false;
    const serviceResultsByServiceId = result.diagnostics?.serviceResultsByServiceId;
    if (!serviceResultsByServiceId) return false;
    return Object.values(serviceResultsByServiceId).some((serviceResult) => serviceResult.status === 'applied');
}

function isPartialAuthSwitchFallbackState(
    result: SessionConnectedServiceAuthSwitchResult,
): boolean {
    if (result.ok) return false;
    const rawResult = readRecord(result);
    const rawDiagnostics = readRecord(rawResult?.diagnostics);
    const rawApplication = readRecord(rawDiagnostics?.application);
    return result.errorCode === 'partial_applied_pending_reconciliation'
        || rawResult?.partialState === 'runtime_auth_partially_applied'
        || rawDiagnostics?.partialState === 'runtime_auth_partially_applied'
        || rawApplication?.status === 'partial_applied_pending_reconciliation';
}

export function resolvePartialAuthSwitchApplicationNotice(
    result: SessionConnectedServiceAuthSwitchResult,
    reconcile: PartialAuthSwitchReconcileContext,
): PartialAuthSwitchApplicationNotice | null {
    if (result.ok) return null;
    const serviceResultsByServiceId = result.diagnostics?.serviceResultsByServiceId;
    if (serviceResultsByServiceId) {
        const serviceResults = Object.entries(serviceResultsByServiceId);
        const hasAppliedService = serviceResults.some(([, serviceResult]) => serviceResult.status === 'applied');
        const nonAppliedServices = serviceResults.flatMap(([serviceId, serviceResult]) => {
            if (serviceResult.status === 'applied') return [];
            return [{
                serviceId,
                status: serviceResult.status,
            }];
        });
        if (hasAppliedService && nonAppliedServices.length > 0) {
            return {
                kind: 'services',
                services: nonAppliedServices,
                ...reconcile,
            };
        }
    }
    return isPartialAuthSwitchFallbackState(result) || hasPartialAuthSwitchApplication(result)
        ? { kind: 'generic', ...reconcile }
        : null;
}

function resolvePartialAuthSwitchServiceStatusLabelKey(
    status: PartialAuthSwitchServiceStatus,
): PartialAuthSwitchServiceStatusLabelKey {
    if (status === 'failed') {
        return 'connectedServices.authSwitch.status.partialApplicationServiceFailed';
    }
    return 'connectedServices.authSwitch.status.partialApplicationServiceNotApplied';
}

/**
 * Service titles for partial hot-apply badges. Daemon-produced service ids are
 * canonical qualified keys resolved against the applied descriptor projection
 * (public title, neutral fallback for an unknown service); a released bundled
 * scalar id keeps the generated built-in compatibility display.
 */
function resolveBadgeServiceTitle(params: Readonly<{
    serviceId: string;
    resolveServiceTitle?: (serviceId: string) => string;
}>): string {
    if (params.resolveServiceTitle) return params.resolveServiceTitle(params.serviceId);
    const qualifiedService = parseQualifiedPluginContributionKey(params.serviceId);
    if (qualifiedService) {
        return resolveQualifiedConnectedServiceRegistryDisplayName(
            getConnectedServiceRegistrySnapshot(),
            qualifiedService,
            t,
        );
    }
    return resolveConnectedServiceDisplayName(params.serviceId as ConnectedServiceId, t);
}

export function buildPartialAuthSwitchApplicationStatusBadges(
    notice: PartialAuthSwitchApplicationNotice | null,
    onReconcile?: () => void,
    resolveServiceTitle?: (serviceId: string) => string,
): ReadonlyArray<AgentInputStatusBadge> {
    if (!notice) return [];
    // The badge is the actionable reconcile surface (session-scope mirror of the
    // pool divergence Retry/Revert) — pressing it offers Retry/Revert.
    const reconcileProps = onReconcile ? { onPress: onReconcile } : {};
    if (notice.kind === 'generic') {
        return [{
            key: 'connected-services-auth-switch-partial-application',
            label: t('connectedServices.authSwitch.status.partialApplication'),
            accessibilityLabel: t('connectedServices.authSwitch.status.partialApplication'),
            testID: 'session-connected-services-auth-switch-partial-application-status',
            tone: 'warning',
            emphasis: 'prominent',
            ...reconcileProps,
        }];
    }
    return notice.services.map((serviceNotice) => {
        const serviceIdToken = toTestIdSafeValue(serviceNotice.serviceId);
        const statusToken = serviceNotice.status.replace(/_/g, '-');
        const labelKey = resolvePartialAuthSwitchServiceStatusLabelKey(serviceNotice.status);
        const serviceName = resolveBadgeServiceTitle({
            serviceId: serviceNotice.serviceId,
            resolveServiceTitle,
        });
        const label = t(labelKey, { service: serviceName });
        return {
            key: `connected-services-auth-switch-service-${serviceIdToken}-${statusToken}`,
            label,
            accessibilityLabel: label,
            testID: `session-connected-services-auth-switch-service-${serviceIdToken}-${statusToken}-status`,
            tone: 'warning',
            emphasis: 'prominent',
            ...reconcileProps,
        };
    });
}
