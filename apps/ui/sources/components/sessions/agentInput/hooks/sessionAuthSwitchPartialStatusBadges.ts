import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import type {
    SessionConnectedServiceAuthSwitchResult,
    SessionConnectedServiceAuthSwitchServiceResult,
} from '@/sync/ops/connectedServices/sessionAuthSwitch';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

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

export type PartialAuthSwitchApplicationNotice =
    | Readonly<{ kind: 'generic' }>
    | Readonly<{
        kind: 'services';
        services: ReadonlyArray<PartialAuthSwitchServiceNotice>;
      }>;

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
            };
        }
    }
    return isPartialAuthSwitchFallbackState(result) || hasPartialAuthSwitchApplication(result)
        ? { kind: 'generic' }
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

export function buildPartialAuthSwitchApplicationStatusBadges(
    notice: PartialAuthSwitchApplicationNotice | null,
): ReadonlyArray<AgentInputStatusBadge> {
    if (!notice) return [];
    if (notice.kind === 'generic') {
        return [{
            key: 'connected-services-auth-switch-partial-application',
            label: t('connectedServices.authSwitch.status.partialApplication'),
            accessibilityLabel: t('connectedServices.authSwitch.status.partialApplication'),
            testID: 'session-connected-services-auth-switch-partial-application-status',
            tone: 'warning',
            emphasis: 'prominent',
        }];
    }
    return notice.services.map((serviceNotice) => {
        const serviceIdToken = toTestIdSafeValue(serviceNotice.serviceId);
        const statusToken = serviceNotice.status.replace(/_/g, '-');
        const labelKey = resolvePartialAuthSwitchServiceStatusLabelKey(serviceNotice.status);
        const serviceName = resolveConnectedServiceDisplayName(serviceNotice.serviceId as ConnectedServiceId, t);
        const label = t(labelKey, { service: serviceName });
        return {
            key: `connected-services-auth-switch-service-${serviceIdToken}-${statusToken}`,
            label,
            accessibilityLabel: label,
            testID: `session-connected-services-auth-switch-service-${serviceIdToken}-${statusToken}-status`,
            tone: 'warning',
            emphasis: 'prominent',
        };
    });
}
