import * as React from 'react';
import { AIBackendProfileSchema } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { Modal } from '@/modal';

import { ExecutionRunSecretReferenceOverlayField, resolveExecutionRunSessionLaunchProfile } from './ExecutionRunSecretReferenceOverlayField';

const sharedRef = 'happier:shared-secret:v1:shared-resource';
const catalogState = vi.hoisted(() => ({
    enabledArgs: [] as boolean[],
    sharedStatus: 'ready' as 'ready' | 'temporarily_unavailable',
    revision: 7,
    entryName: 'Acme shared OpenAI key',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown>) => React.createElement('Text', props, props.children as React.ReactNode),
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ meta: { OPENAI_API_KEY: { isSet: false } } }),
}));

vi.mock('@/components/secrets/useSavedSecretCatalog', () => ({
    useSavedSecretCatalog: (options?: { sharedEnabled?: boolean }) => {
        catalogState.enabledArgs.push(options?.sharedEnabled !== false);
        return {
            sharedEnabled: options?.sharedEnabled !== false,
            resolveReference: (ref: string) => ({
                ref,
                kind: ref.startsWith('happier:shared-secret:v1:') ? 'shared_resource' : 'personal',
                status: ref === sharedRef ? catalogState.sharedStatus : 'ready',
                entry: ref === sharedRef ? {
                    ref,
                    source: 'shared_resource',
                    relationship: 'recipient',
                    name: catalogState.entryName,
                    kind: 'apiKey',
                    encryptionMode: 'e2ee',
                    owner: null,
                    accessSources: [],
                    audience: null,
                    ownerAccountId: 'owner-1',
                    revision: catalogState.revision,
                    materialStatus: catalogState.sharedStatus,
                    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
                } : null,
                secret: null,
                revision: ref === sharedRef ? catalogState.revision : null,
                fingerprint: `test:${ref}`,
            }),
        };
    },
}));

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn() },
}));

const profile = AIBackendProfileSchema.parse({
    id: 'profile-work',
    name: 'Work',
    envVarRequirements: [{ name: 'OPENAI_API_KEY', required: true, kind: 'secret' }],
});

describe('ExecutionRunSecretReferenceOverlayField', () => {
    it('resolves the Session profile from the canonical catalog with its entity bindings', () => {
        const canonicalProfile = { ...profile, secretBindings: { OPENAI_API_KEY: sharedRef } };

        expect(resolveExecutionRunSessionLaunchProfile({ profileId: profile.id }, [canonicalProfile])).toEqual(canonicalProfile);
        expect(resolveExecutionRunSessionLaunchProfile({ profileId: profile.id }, [])).toBeNull();
    });

    beforeEach(() => {
        catalogState.enabledArgs = [];
        catalogState.sharedStatus = 'ready';
        catalogState.revision = 7;
        catalogState.entryName = 'Acme shared OpenAI key';
        vi.mocked(Modal.show).mockReset();
    });

    afterEach(() => standardCleanup());

    it('selects and reviews the exact value-free non-default shared reference without changing the Profile', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(
            <ExecutionRunSecretReferenceOverlayField
                profile={profile}
                machineId="machine-1"
                serverId="home-1"
                accountScope={{ serverId: 'home-1', accountId: 'account-1' }}
                defaultBindings={{ OPENAI_API_KEY: 'personal-default' }}
                personalSecrets={[]}
                sharedEnabled
                editable
                onChange={onChange}
            />,
        );

        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        const modalProps = vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props as {
            onResolve: (result: unknown) => void;
        };
        modalProps.onResolve({
            action: 'selectSaved',
            envVarName: 'OPENAI_API_KEY',
            secretId: sharedRef,
            setDefault: false,
        });
        await flushHookEffects({ cycles: 3 });

        const overlay = {
            v: 1,
            bindings: { OPENAI_API_KEY: { ref: sharedRef, revision: 7 } },
        };
        expect(onChange).toHaveBeenLastCalledWith({ readiness: { ok: true, secretReferenceOverlay: overlay }, overlay });
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain('OPENAI_API_KEY');
        expect(rendered).toContain('Acme shared OpenAI key');
        expect(rendered).toContain('Ready');
        expect(rendered).not.toContain(sharedRef);
        expect(rendered).not.toContain('revision');
        expect(rendered).not.toContain('sealed');
        expect(profile).toEqual(expect.objectContaining({ id: 'profile-work' }));
    });

    it('keeps a selected shared reference visible as typed unavailable when the exact Home feature closes', async () => {
        const onChange = vi.fn();
        const render = (sharedEnabled: boolean) => (
            <ExecutionRunSecretReferenceOverlayField
                profile={profile}
                machineId="machine-1"
                serverId="home-1"
                accountScope={{ serverId: 'home-1', accountId: 'account-1' }}
                defaultBindings={{ OPENAI_API_KEY: 'personal-default' }}
                personalSecrets={[]}
                sharedEnabled={sharedEnabled}
                editable
                onChange={onChange}
            />
        );
        const screen = await renderScreen(render(true));
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        const modalProps = vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props as {
            onResolve: (result: unknown) => void;
        };
        modalProps.onResolve({ action: 'selectSaved', envVarName: 'OPENAI_API_KEY', secretId: sharedRef, setDefault: false });
        await flushHookEffects({ cycles: 2 });

        catalogState.sharedStatus = 'temporarily_unavailable';
        await screen.update(render(false));
        await flushHookEffects({ cycles: 2 });

        expect(catalogState.enabledArgs).toContain(false);
        expect(onChange).toHaveBeenLastCalledWith({
            readiness: { ok: false, reason: 'saved_secret_selection_unavailable' },
        });
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain('OPENAI_API_KEY');
        expect(rendered).toContain('Acme shared OpenAI key');
        expect(rendered).toContain('Temporarily unavailable');
        expect(rendered).not.toContain('saved_secret_selection_unavailable');
        expect(rendered).not.toContain('temporarily_unavailable');
        expect(rendered).not.toContain(sharedRef);
    });
});
