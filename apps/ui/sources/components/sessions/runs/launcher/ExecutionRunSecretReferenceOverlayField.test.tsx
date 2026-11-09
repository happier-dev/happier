import * as React from 'react';
import { act } from 'react-test-renderer';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { applySavedSecretCatalogPage, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { Modal } from '@/modal';
import { ConnectSheetContent } from '@/components/settings/connectedServices/setup/ConnectSheetContent';
import type { ConnectSheetContentProps } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';

import { ExecutionRunSecretReferenceOverlayField, resolveExecutionRunSessionLaunchProfile } from './ExecutionRunSecretReferenceOverlayField';

const viewport = vi.hoisted(() => ({ width: 390 }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(async () => ({
        policy: 'redacted', values: {
            OPENAI_API_KEY: { isSet: true, display: 'redacted' },
            ANTHROPIC_API_KEY: { isSet: true, display: 'redacted' },
        },
    })));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Connect imports the native Markdown SDK for its account variant; this key journey never renders it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in key selection'); },
}));
installDisconnectedServerSocketBoundary();

const profile = AIBackendProfileSchema.parse({ id: 'profile-work', name: 'Work',
    envVarRequirements: [{ name: 'OPENAI_API_KEY', required: true, kind: 'secret' }],
});
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;

beforeEach(() => {
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    viewport.width = 390;
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    vi.mocked(Modal.show).mockClear();
});
afterEach(async () => {
    await standardCleanup();
    resetSavedSecretCatalogEngineForTests();
    await home?.dispose();
    home = null;
});

async function setup(options: Readonly<{ multiRequirement?: boolean }> = {}) {
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
    const { entry } = await home.addOwnerResource();
    const fieldProfile = options.multiRequirement ? AIBackendProfileSchema.parse({ ...profile,
        envVarRequirements: [...profile.envVarRequirements!, { name: 'ANTHROPIC_API_KEY', required: true, kind: 'secret' }],
    }) : profile;
    const onChange = vi.fn();
    const render = (sharedEnabled = true) => <ExecutionRunSecretReferenceOverlayField profile={fieldProfile}
        machineId={options.multiRequirement ? 'machine-1' : null} serverId={home!.scope.serverId} accountScope={home!.scope}
        defaultBindings={options.multiRequirement ? { OPENAI_API_KEY: entry.ref } : null}
        personalSecrets={[]} sharedEnabled={sharedEnabled} editable onChange={onChange} />;
    const screen = await renderScreen(render());
    await act(async () => refreshSavedSecretCatalog(home!.scope, { includeMaterial: false }));
    await flushHookEffects({ cycles: 2 });
    return { entry, onChange, screen, render };
}

describe('ExecutionRunSecretReferenceOverlayField', () => {
    it('resolves the Session profile from the canonical catalog with its entity bindings', () => {
        const canonicalProfile = { ...profile, secretBindings: { OPENAI_API_KEY: 'happier:shared-secret:v1:resource-a' } };
        expect(resolveExecutionRunSessionLaunchProfile({ profileId: profile.id }, [canonicalProfile])).toEqual(canonicalProfile);
        expect(resolveExecutionRunSessionLaunchProfile({ profileId: profile.id }, [])).toBeNull();
    });

    it('selects a Saved Secret inline on a phone without another modal, then retains typed readiness on withdrawal', async () => {
        const { entry, onChange, screen, render } = await setup();
        expect(screen.findAllByType(ConnectSheetContent)).toHaveLength(0);
        const materialReads = () => home!.request.mock.calls.filter(([url]) =>
            new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials').length;
        expect(materialReads()).toBe(0);
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        expect(Modal.show).not.toHaveBeenCalled();
        expect(screen.findAllByType(ConnectSheetContent)).toHaveLength(1);
        await screen.pressByTestIdAsync('connect-key-sheet:mode:saved');
        await screen.pressByTestIdAsync(`connect-key-sheet:saved:${entry.ref}`);
        await screen.pressByTestIdAsync('connect-key-sheet:use');
        const overlay = { v: 1, bindings: { OPENAI_API_KEY: { ref: entry.ref, revision: entry.revision } } };
        expect(onChange).toHaveBeenLastCalledWith({ readiness: { ok: true, secretReferenceOverlay: overlay }, overlay });
        expect(screen.findAllByType(ConnectSheetContent)).toHaveLength(0);
        expect(screen.getTextContent()).toContain(entry.name);
        expect(screen.getTextContent()).not.toContain(entry.ref);
        expect(materialReads()).toBe(0);
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        await screen.pressByTestIdAsync('connect-key-sheet:cancel');
        expect(screen.findAllByType(ConnectSheetContent)).toHaveLength(0);
        expect(onChange).toHaveBeenLastCalledWith({ readiness: { ok: true, secretReferenceOverlay: overlay }, overlay });
        await act(async () => applySavedSecretCatalogPage({ scope: home!.scope,
            entries: [{ ...entry, materialStatus: 'temporarily_unavailable' }], observedAt: 2 }));
        expect(onChange).toHaveBeenLastCalledWith({ readiness: { ok: false, reason: 'saved_secret_selection_unavailable' } });
        await screen.update(render(false));
        expect(onChange).toHaveBeenLastCalledWith({ readiness: { ok: false, reason: 'saved_secret_selection_unavailable' } });
        expect(screen.getTextContent()).toContain(entry.name);
        expect(screen.getTextContent()).not.toContain('temporarily_unavailable');
    });

    it('uses the existing anchored Connect presenter on wide layouts and returns only the exact reference', async () => {
        viewport.width = 1200;
        const { entry, onChange, screen } = await setup();
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        const modal = vi.mocked(Modal.show).mock.calls.at(-1)![0];
        expect(modal.component).toBe(ConnectSheetContent);
        expect(modal.chrome).toMatchObject({ kind: 'card', phonePresentation: 'sheet', anchor: { kind: 'view' } });
        const content = modal.props as ConnectSheetContentProps;
        expect(content.request).toMatchObject({ scope: home!.scope, service: { kind: 'key', suggestedName: 'OPENAI_API_KEY' } });
        await act(async () => content.onResult({ kind: 'selected', secretRef: entry.ref }));
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ overlay: {
            v: 1, bindings: { OPENAI_API_KEY: { ref: entry.ref, revision: entry.revision } },
        } }));
        expect(screen.findAllByType(ConnectSheetContent)).toHaveLength(0);
        expect(Modal.hide).toHaveBeenCalledWith('modal-id');
    });

    it('retains Profile defaults and selects a different requirement or its Machine environment inline', async () => {
        const { entry, onChange, screen } = await setup({ multiRequirement: true });
        expect(onChange).toHaveBeenLastCalledWith({ readiness: { ok: true } });
        expect(screen.findByTestId('execution-run-secret-machine:OPENAI_API_KEY')).toBeNull();
        await screen.pressByTestIdAsync('execution-run-secret-saved:ANTHROPIC_API_KEY');
        await screen.pressByTestIdAsync('connect-key-sheet:mode:saved');
        await screen.pressByTestIdAsync(`connect-key-sheet:saved:${entry.ref}`);
        await screen.pressByTestIdAsync('connect-key-sheet:use');
        const overlay = { v: 1, bindings: { ANTHROPIC_API_KEY: { ref: entry.ref, revision: entry.revision } } };
        expect(onChange).toHaveBeenLastCalledWith({ readiness: { ok: true, secretReferenceOverlay: overlay }, overlay });
        await screen.pressByTestIdAsync('execution-run-secret-machine:ANTHROPIC_API_KEY');
        expect(onChange).toHaveBeenLastCalledWith({ readiness: { ok: true } });
        expect(Modal.show).not.toHaveBeenCalled();
    });
});
