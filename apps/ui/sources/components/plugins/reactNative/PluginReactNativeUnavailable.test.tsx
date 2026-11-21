import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { findAllHostTestInstances, renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { PluginReactNativeUnavailable } from './PluginReactNativeUnavailable';
import { PluginHostedWebUnavailable, readPluginHostedWebUnavailableDiagnosticCode } from '../hostedWeb/PluginHostedWebUnavailable';
import { acquirePluginSelectedArtifactLease } from '@/sync/domains/plugins/availability/artifactLease';
import { createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';
import { createPluginArtifactDaemonSource } from '@/sync/domains/plugins/availability/artifactDaemonSource';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1, PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function createCurrentArtifactReader() {
    const scope = { serverId: 'home', accountId: 'account' };
    const availability = createPluginAccountAvailabilityReaderStore();
    availability.replace({
        scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
    });
    return availability.bind(scope);
}

describe('PluginReactNativeUnavailable', () => {
    it('retains the daemon transfer reason through acquisition and offers Retry for the same refusal', async () => {
        const bytes = new TextEncoder().encode('view');
        const entry = 'hosted-web/view/index.html';
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entry, bytes }]);
        const slot = { pluginId: 'com.acme.fixture', contributionId: 'view', tier: 'hostedWeb', platform: 'web' } as const;
        const result = await acquirePluginSelectedArtifactLease({
            reader: createCurrentArtifactReader(),
            slot,
            daemonProjectionSelection: {
                occurrenceId: 'fixture-route-occurrence',
                artifact: { ...slot, artifactId: 'view', digest, hostUiApiRange: '^1.0.0', releaseVersion: '1.0.0' },
                isCurrent: () => true,
            },
            artifactGraph: PluginUiArtifactsManifestEntryV2Schema.parse({
                artifactId: 'view', tier: 'hostedWeb', entry, digest,
                hostUiApiRange: '^1.0.0', builtWith: { staging: 'staticDirectory' },
                files: [{ relativePath: entry, byteSize: bytes.byteLength, digest: computePluginUiArtifactSha256DigestV1(bytes) }],
            }),
            sources: [createPluginArtifactDaemonSource({
                transport: { machineId: 'machine', serverId: 'home' }, family: 'hostedWeb',
                fetchArtifactBytes: async () => ({
                    ok: false, code: 'artifact_unavailable', diagnostics: ['artifact_bytes_fetch_failed'],
                    failureReason: 'machine_carrier_transport_failed',
                }),
            })],
        });
        if (result.kind !== 'unavailable') throw new Error('Expected unavailable route');
        expect(result).toMatchObject({
            code: 'artifact_bytes_fetch_failed',
            diagnostics: ['artifact_bytes_fetch_failed', 'machine_carrier_transport_failed'],
        });
        const retry = vi.fn();
        const repair = vi.fn();
        const screen = await renderScreen(<PluginReactNativeUnavailable
            diagnostics={result.diagnostics}
            onRetry={retry} recoveryAction={{ label: 'route fallback', onPress: repair }}
        />);
        expect(screen.getTextContent()).toContain(t('pluginRuntime.transportUnavailable'));
        expect(screen.findByTestId(
            'plugin-rn-ui-unavailable-diagnostic-artifact_bytes_fetch_failed|machine_carrier_transport_failed',
        )).toBeTruthy();
        await act(async () => { screen.pressByTestId('plugin-rn-ui-unavailable-details-toggle'); });
        expect(screen.getTextContent()).toContain('artifact_bytes_fetch_failed|machine_carrier_transport_failed');
        await act(async () => { screen.pressByTestId('plugin-rn-ui-unavailable-action'); });
        expect(retry).toHaveBeenCalledOnce();
        expect(repair).not.toHaveBeenCalled();
    });

    it.each([
        ['plugin_collection_contract_conflict', 'settingsPlugins.managePlugin'],
        ['plugin_resource_admission_unavailable', 'settingsPlugins.managePlugin'],
        ['plugin_host_access_disclosure_mismatch', 'settingsPlugins.managePlugin'],
        ['artifact_bytes_rpc_unavailable', 'common.retry'],
        ['artifact_bytes_response_invalid', 'common.retry'],
        ['artifact_bytes_fetch_failed', 'common.retry'],
        ['plugin_resource_transport_not_supported', 'common.retry'],
        ['plugin_resource_transport_error', 'common.retry'],
        ['plugin_resource_transport_timeout', 'common.retry'],
        ['targeted_contributions_invalid_response', 'common.retry'],
        ['targeted_contributions_error', 'common.retry'],
    ] as const)('explains %s and invokes its one real recovery callback', async (code, labelKey) => {
        const repair = vi.fn();
        const retry = vi.fn();
        const screen = await renderScreen(
            <PluginReactNativeUnavailable
                diagnostics={[code]}
                onRetry={retry}
                recoveryAction={{ label: 'route fallback', onPress: repair }}
            />,
        );
        expect(screen.getTextContent()).not.toContain(t('pluginRuntime.unavailableGeneric'));
        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe(t(labelKey));
        await act(async () => { screen.pressByTestId('plugin-rn-ui-unavailable-action'); });
        expect(labelKey === 'common.retry' ? retry : repair).toHaveBeenCalledOnce();
        expect(labelKey === 'common.retry' ? repair : retry).not.toHaveBeenCalled();
    });

    it('preserves a real Artifact graph refusal through hosted presentation and its repair action', async () => {
        const slot = { pluginId: 'com.acme.fixture', contributionId: 'view', tier: 'hostedWeb', platform: 'web' } as const;
        const result = await acquirePluginSelectedArtifactLease({
            reader: createCurrentArtifactReader(),
            slot,
            daemonProjectionSelection: {
                occurrenceId: 'fixture-occurrence',
                artifact: { ...slot, artifactId: 'view', digest: `sha256:${'a'.repeat(64)}`, hostUiApiRange: '^1.0.0', releaseVersion: '1.0.0' },
                isCurrent: () => true,
            },
            artifactGraph: null,
            sources: [],
        });
        expect(result.kind).toBe('unavailable');
        if (result.kind !== 'unavailable') throw new Error('Expected graph admission refusal');
        expect(result.code).toBe('artifact_graph_invalid');
        const repair = vi.fn();
        const retry = vi.fn();
        const screen = await renderScreen(
            <PluginHostedWebUnavailable
                diagnosticCode={readPluginHostedWebUnavailableDiagnosticCode(result.code) ?? 'response_invalid'}
                onRetry={retry}
                recoveryAction={{ label: 'route fallback', onPress: repair }}
            />,
        );
        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-artifact_graph_invalid')).toBeTruthy();
        expect(screen.getTextContent()).toContain(t('pluginRuntime.authorFailure'));
        expect(screen.findByTestId('plugin-hosted-web-unavailable-action')?.props.accessibilityLabel).toBe(t('settingsPlugins.managePlugin'));
        await act(async () => { screen.pressByTestId('plugin-hosted-web-unavailable-action'); });
        expect(repair).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
    });

    it('preserves unavailable, Retry, and pending accessibility semantics', async () => {
        const unavailable = await renderScreen(
            <PluginReactNativeUnavailable diagnostics={['artifact_unavailable']} />,
        );
        // Diagnostic Details stays outside the live region; the shared card announces its sentence.
        expect(findAllHostTestInstances(unavailable.root, (node) => node.props.accessibilityLiveRegion === 'polite'))
            .not.toHaveLength(0);
        expect(unavailable.findByTestId('plugin-rn-ui-unavailable-action')).toBeNull();

        const onRetry = vi.fn();
        const failed = await renderScreen(<PluginReactNativeUnavailable onRetry={onRetry} />);
        expect(failed.findByTestId('plugin-rn-ui-unavailable')?.props.accessibilityLiveRegion).toBe('assertive');
        expect(failed.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe(t('common.retry'));
        await act(async () => {
            failed.pressByTestId('plugin-rn-ui-unavailable-action');
        });
        expect(onRetry).toHaveBeenCalledOnce();

        const retrying = await renderScreen(<PluginReactNativeUnavailable onRetry={onRetry} retrying />);
        expect(retrying.findByTestId('plugin-rn-ui-unavailable-loading-spinner')).toBeTruthy();
        expect(retrying.findByTestId('plugin-rn-ui-unavailable')?.props.accessibilityLiveRegion).toBe('polite');
        expect(retrying.findByTestId('plugin-rn-ui-unavailable-action')).toBeNull();
    });

    it('explains a disabled plugin before offering the route-owned Enable action', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <PluginReactNativeUnavailable diagnostics={['plugin_disabled']} recoveryAction={{ label: 'route fallback', onPress }} />,
        );
        expect(screen.getTextContent()).toContain(t('pluginRuntime.disabledByPolicy'));
        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe(t('common.enable'));
        await act(async () => { screen.pressByTestId('plugin-rn-ui-unavailable-action'); });
        expect(onPress).toHaveBeenCalledOnce();
    });

    it.each([
        ['artifact_source_integrity_invalid', 'settingsPlugins.managePlugin'],
        ['artifact_incompatible', 'common.update'],
        ['module_instantiation_failed', 'settingsPlugins.managePlugin'],
    ] as const)('routes %s through the existing route recovery action as %s', async (diagnostic, labelKey) => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <PluginReactNativeUnavailable
                diagnostics={[diagnostic]}
                recoveryAction={{ label: 'route fallback', onPress }}
            />,
        );

        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe(t(labelKey));
        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
        });
        expect(onPress).toHaveBeenCalledOnce();
    });
});
