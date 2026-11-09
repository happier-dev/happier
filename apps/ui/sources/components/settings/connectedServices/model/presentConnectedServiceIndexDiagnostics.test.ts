import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { buildConnectedServicesIndexModel } from './buildConnectedServicesIndexModel';
import {
    presentConnectedServiceIndexDiagnosticCopy,
    presentConnectedServiceIndexDiagnostics,
    presentConnectedServiceRegistryReadFailure,
    presentConnectedServiceRegistryReadState,
} from './presentConnectedServiceIndexDiagnostics';

describe('Connected service index read diagnostics', () => {
    it('keeps partial Machine coverage quiet while preserving pending, empty and failed read verdicts', () => {
        expect(presentConnectedServiceRegistryReadState({ status: 'stale', errorReason: 'partial_machine_failure' })).toBeNull();
        expect(presentConnectedServiceRegistryReadState({ status: 'error', errorReason: 'partial_machine_failure' })).toBeNull();
        expect(presentConnectedServiceRegistryReadState({ status: 'loading', errorReason: null })).toBeNull();
        expect(presentConnectedServiceRegistryReadState({ status: 'ready', errorReason: null })).toBeNull();
        expect(presentConnectedServiceRegistryReadState({ status: 'error', errorReason: 'transport' })).not.toBeNull();
        expect(presentConnectedServiceRegistryReadState({ status: 'stale', errorReason: 'malformed' })).not.toBeNull();
    });

    it('keeps a service pending until negotiation and its descriptor read settle, then presents the actual verdict', () => {
        const service = { pluginId: 'acme.service', localId: 'custom-service' };
        const entry: ConnectedServiceRegistryEntry = {
            serviceId: service.localId, service, connectCommand: '', supportsOauth: false,
            executable: false, projectionStatus: 'loading',
            availability: { state: 'blocked', reason: 'missing_runtime' }, diagnostics: ['missing_runtime'],
        };
        const project = (candidate: ConnectedServiceRegistryEntry, transport: 'indeterminate' | 'advertised-v4') =>
            buildConnectedServicesIndexModel({
                transport, entries: [candidate], qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
                defaultAccountByServiceKey: {}, resolveLabel: () => 'Custom service', resolveFallbackEntry: () => null,
                loadingLabel: t('common.loading'),
                presentDiagnostics: current => presentConnectedServiceIndexDiagnostics({ entry: current }),
            });
        expect(project(entry, 'advertised-v4').sheets[0]).toMatchObject({
            statusLine: t('common.loading'), supportDetails: null, canAdd: false,
        });
        const settled = { ...entry, projectionStatus: 'ready' as const };
        expect(project(settled, 'indeterminate').sheets[0]).toMatchObject({
            statusLine: t('common.loading'), supportDetails: null, canAdd: false,
        });
        // The reason leads (what is wrong and what to do), never a bare "Blocked".
        expect(project(settled, 'advertised-v4').sheets[0]).toMatchObject({
            statusLine: t('connectedServicesSettings.runtimeNotLoaded'), supportDetails: expect.any(String), canAdd: false,
        });
        const available: ConnectedServiceRegistryEntry = { ...settled, executable: true,
            availability: { state: 'available', reason: 'resolved' }, diagnostics: [] };
        expect(project(available, 'advertised-v4').connectable.map(candidate => candidate.service)).toEqual([service]);
    });

    it('leaves a service that only lacks a machine to run it quiet: the page and the + menu say it once', () => {
        const entry: ConnectedServiceRegistryEntry = { serviceId: 'gemini',
            service: { pluginId: 'happier.agent.gemini', localId: 'gemini' },
            connectCommand: '', supportsOauth: true, executable: false, projectionStatus: 'ready',
            availability: { state: 'blocked', reason: 'execution_origin_unavailable' }, diagnostics: [] };
        const result = presentConnectedServiceIndexDiagnostics({ entry });
        expect(result.primary).toBeNull();
        // The fact stays available in the service's details.
        expect(result.supportDetails).toContain(t('common.blocked'));
    });

    it('keeps an answered available service usable when its plugin reports an unrelated runtime diagnostic', () => {
        const entry: ConnectedServiceRegistryEntry = { serviceId: 'openai-codex',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            connectCommand: '', supportsOauth: true, executable: true, projectionStatus: 'ready',
            availability: { state: 'available', reason: 'resolved' }, diagnostics: ['plugin_external_session_source_refused'] };
        const result = presentConnectedServiceIndexDiagnostics({ entry });
        expect(result.primary).toBeNull();
        expect(result.supportDetails).toBe(t('settingsPlugins.diagnosticsSnapshotFooter'));
        const index = buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries: [entry], qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
            defaultAccountByServiceKey: {}, resolveLabel: () => 'ChatGPT', resolveFallbackEntry: () => null,
            loadingLabel: t('common.loading'), presentDiagnostics: candidate => presentConnectedServiceIndexDiagnostics({ entry: candidate }),
        });
        expect(index.connectable.map(service => service.service)).toEqual([entry.service]);
    });
    it('keeps unknown boundary diagnostics on the read-failure path without disclosing boundary text', () => {
        expect(presentConnectedServiceIndexDiagnosticCopy('untrusted registry response https://private.example'))
            .toBe(presentConnectedServiceRegistryReadFailure(null));
        expect(presentConnectedServiceIndexDiagnosticCopy('missing_runtime'))
            .toBe(t('connectedServicesSettings.runtimeNotLoaded'));
    });

    it('keeps a conflicting service visible during a partial read even when no executable descriptor was admitted', () => {
        const entry: ConnectedServiceRegistryEntry = {
            serviceId: 'custom-service', service: { pluginId: 'acme.service', localId: 'custom-service' },
            connectCommand: '', supportsOauth: false, executable: false, projectionStatus: 'stale',
            projectionConflicts: [{ kind: 'identity_divergence', descriptorIdentity: 'private-owner-id', serviceIds: ['custom-service'] }],
        };
        const result = presentConnectedServiceIndexDiagnostics({ entry });
        expect(result.primary).toBe(t('connectedServicesSettings.identityConflict'));
        expect(result.supportDetails).toBe(t('connectedServicesSettings.identityConflict'));
        expect(JSON.stringify(result)).not.toContain('private-owner-id');
        const index = buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries: [entry], qualifiedAccounts: [], qualifiedGroups: [],
            legacyServices: [], defaultAccountByServiceKey: {}, resolveLabel: () => 'Custom service',
            resolveFallbackEntry: () => null, loadingLabel: t('common.loading'),
            presentDiagnostics: candidate => presentConnectedServiceIndexDiagnostics({ entry: candidate }),
        });
        expect(index.sheets).toHaveLength(1);
        expect(index.sheets[0]).toMatchObject({ statusLine: result.primary, supportDetails: result.supportDetails, canAdd: false });
    });

    it.each(['blocked', 'disabled'] as const)('keeps a conflict headline and every safe %s availability fact in Details', (state) => {
        const entry: ConnectedServiceRegistryEntry = {
            serviceId: 'custom-service', service: { pluginId: 'acme.service', localId: 'custom-service' },
            connectCommand: '', supportsOauth: false, executable: false, projectionStatus: 'stale',
            projectionConflicts: [{ kind: 'identity_divergence', descriptorIdentity: 'owner-id', serviceIds: ['custom-service'] }],
            availability: { state, reason: 'unresolved' }, diagnostics: ['plugin_unavailable', 'missing_runtime', 'untrusted https://private.example'],
        };
        const result = presentConnectedServiceIndexDiagnostics({ entry });
        expect(result.primary).toBe(t('connectedServicesSettings.identityConflict'));
        expect(result.supportDetails?.split('\n')).toEqual([
            t('connectedServicesSettings.identityConflict'),
            t(state === 'blocked' ? 'common.blocked' : 'common.disabled'),
            presentConnectedServiceRegistryReadFailure(null),
            t('connectedServicesSettings.runtimeNotLoaded'),
        ]);
        expect(JSON.stringify(result)).not.toContain('private.example');
    });

    it('keeps an ordinary saved identity quiet while no machine has supplied a descriptor', () => {
        expect(presentConnectedServiceIndexDiagnostics({ entry: {
            serviceId: 'custom-service', connectCommand: '', supportsOauth: false,
        } })).toEqual({ primary: null, supportDetails: null });
    });
});
