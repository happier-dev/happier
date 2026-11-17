import * as React from 'react';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { isHealthCheckEventSourceV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { readServiceCheckDefinitions, type ServiceCheckDefinitionFacts } from '@/components/projects/deployments/serviceCheckPresentation';
import { useDeploymentAccountController } from '@/components/projects/deployments/useDeploymentProject';
import { useDeploymentDomainPage } from '@/components/projects/deployments/useDeploymentReads';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveAutomationRunDetailAccountMaterial } from '@/sync/domains/automations/automationRunDetailInspection';
import { retainAutomationDefinitionDetailsDemand } from '@/sync/domains/automations/automationReadDemand';
import { readPluginEventAutomationPrivateDetail, type PluginEventAutomationStoredContentAccess } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { isPluginEventAutomationTrigger, type AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { resolvePluginLocalizedText } from '@/sync/domains/plugins/ui/i18n';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

export type ConfiguredCheckDefinitionFacts =
    | Readonly<{ kind: 'loading' | 'unavailable' }>
    | Readonly<{ kind: 'available'; checks: readonly Pick<ServiceCheckDefinitionFacts, 'checkId' | 'name' | 'targetLabel' | 'periodMs' | 'domainId' | 'keyFlow'>[];
        /** The Machine assigned to run the source's checks; null until assigned, or when results arrive by webhook. */
        observerMachineId: string | null }>;
export const CONFIGURED_CHECK_DEFINITION_LOADING: ConfiguredCheckDefinitionFacts = Object.freeze({ kind: 'loading' });
const UNAVAILABLE: ConfiguredCheckDefinitionFacts = Object.freeze({ kind: 'unavailable' });
const NO_DOMAINS = Object.freeze([]);
export function configuredCheckDefinitionKey(automationId: string, triggerId: string): string {
    return JSON.stringify([automationId, triggerId]);
}

/** One presented Account page lends its private definitions to Checks; it never opens a detail per row. */
export function useConfiguredCheckDefinitions(lifetime: ServerAccountScopeLifetime | null, presented: boolean,
    automations: readonly AutomationDefinition[]) {
    const reader = usePluginAccountAvailabilityReader(lifetime?.scope ?? null, HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, { enabled: presented });
    React.useEffect(() => {
        if (!presented || !lifetime) return;
        const active = captureActiveServerAccountScopeLifetime();
        if (!active || !areServerAccountScopesEqual(active.scope, lifetime.scope)) return;
        const release = retainAutomationDefinitionDetailsDemand(active);
        void import('@/sync/sync').then(({ sync }) => sync.ensureAutomationsRead()).catch(() => {});
        return release;
    }, [lifetime, presented]);
    const needsContent = presented && automations.some(definition => definition.triggers.some(trigger =>
        isPluginEventAutomationTrigger(trigger) && isHealthCheckEventSourceV1(trigger)));
    const [opened, setOpened] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime; access: PluginEventAutomationStoredContentAccess | null;
    }> | null>(null);
    React.useEffect(() => {
        if (!needsContent || !lifetime?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        void (async () => {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const account = await captureLazyActionAccountContext(lifetime.scope.serverId, controller.signal);
            try {
                const currentness = await fetchAccountEncryptionCurrentness(account.credentials, {
                    request: (path, init) => account.request(path, { ...init, signal: controller.signal }, { includeAuth: false }),
                    signal: controller.signal,
                });
                account.assertCurrent();
                const material = resolveAutomationRunDetailAccountMaterial({ credentials: account.credentials, accountCurrentness: currentness });
                if (!controller.signal.aborted && lifetime.isCurrent()) setOpened({ lifetime, access: material.kind === 'available'
                    ? { mode: currentness.mode, ...(material.material ? { material: material.material } : {}) } : null });
            } finally { account.dispose(); }
        })().catch(() => { if (!controller.signal.aborted && lifetime.isCurrent()) setOpened({ lifetime, access: null }); });
        return () => { controller.abort(); retirement.dispose(); setOpened(null); };
    }, [lifetime, needsContent]);
    const sources = React.useMemo(() => {
        if (!presented || !lifetime?.isCurrent()) return [];
        return automations.flatMap(definition => definition.triggers.flatMap(trigger => {
            if (!isPluginEventAutomationTrigger(trigger) || !isHealthCheckEventSourceV1(trigger)) return [];
            const privateDetail = opened?.lifetime === lifetime && opened.access
                ? readPluginEventAutomationPrivateDetail(definition, trigger.id, opened.access) : null;
            return [{ key: configuredCheckDefinitionKey(definition.id, trigger.id),
                source: privateDetail?.storedDefinition ?? null,
                observation: privateDetail?.trigger.observation ?? null,
                loading: definition.detail.kind === 'unloaded' || opened?.lifetime !== lifetime }];
        }));
    }, [presented, lifetime, automations, opened]);
    const base = React.useMemo(() => sources.map(entry => ({ ...entry,
        checks: entry.source ? readServiceCheckDefinitions(entry.source) : null })), [sources]);
    const needsDomains = base.some(entry => entry.checks?.some(check => check.domainId !== null));
    const domainDemand = React.useMemo(() => ({ mounted: presented && needsDomains, visible: presented && needsDomains, focused: presented && needsDomains }),
        [presented, needsDomains]);
    const controller = useDeploymentAccountController(lifetime, needsDomains, domainDemand);
    const domainPage = useDeploymentDomainPage(controller, domainDemand);
    const domains = domainPage.snapshot.value?.items ?? NO_DOMAINS;
    const byTrigger = React.useMemo(() => {
        const declarations = reader?.readCurrentAccountExecutionDeclarations() ?? [];
        const installed = reader?.readInstalledPlugins();
        const projection = reader?.readAccountUiProjection();
        return new Map<string, ConfiguredCheckDefinitionFacts>(base.map(entry => {
            if (!entry.source) return [entry.key, entry.loading ? CONFIGURED_CHECK_DEFINITION_LOADING : UNAVAILABLE];
            const observer = entry.observation?.kind === 'durablePush' ? entry.observation.endpointMaterializationRef
                : entry.observation?.watcher;
            const checks = readServiceCheckDefinitions(entry.source, { domains, kindName: kind => {
                const manifest = declarations.find(candidate => candidate.manifest.id === kind.pluginId)?.manifest
                    ?? (observer && installed?.kind === 'available' ? installed.plugins.find(plugin => plugin.pluginId === kind.pluginId)
                        ?.installations.find(({ materialization }) => materialization.machineId === observer.machineId
                            && materialization.pluginId === observer.pluginId && materialization.materializationId === observer.materializationId)
                        ?.contributorDeclaration : null);
                const declaration = manifest?.contributes.healthCheckKinds?.find(candidate => candidate.id === kind.localId);
                return declaration ? resolvePluginLocalizedText({ projection, pluginId: kind.pluginId, value: declaration.title }) : null;
            } });
            return [entry.key, checks ? { kind: 'available', checks: checks.map(({ checkId, name, targetLabel, periodMs, domainId, keyFlow }) =>
                ({ checkId, name, targetLabel, periodMs, domainId, keyFlow })),
                observerMachineId: entry.observation?.kind === 'durablePush' ? null : entry.observation?.watcher?.machineId ?? null } : UNAVAILABLE];
        }));
    }, [base, domains, reader]);
    return { byTrigger, domainsPending: needsDomains && domainPage.snapshot.status !== 'ready',
        domainContinuation: needsDomains && domainPage.hasNextPage ? domainPage.nextPage : undefined };
}
