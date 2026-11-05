import { describe, expect, it } from 'vitest';
import { resolveConnectSheetOpening } from './connectSheetOpening';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const otherService = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
const first = { service, accountId: 'personal' };
const current = { service, accountId: 'work' };

describe('Connect sheet opening choice', () => {
    it('opens Saved for the same service and prefers the caller’s current account', () => {
        expect(resolveConnectSheetOpening({ service, account: current }, { accounts: [first, current].map(ref => ({ ref, status: 'connected' as const })) }))
            .toMatchObject({ initialMode: 'saved', preselected: current });
        expect(resolveConnectSheetOpening({ service }, { accounts: [first, current].map(ref => ({ ref, status: 'connected' as const })) }))
            .toMatchObject({ initialMode: 'saved', preselected: first });
    });

    it('never preselects a signed-out account, including the current link or an all-signed-out inventory', () => {
        const signedOut = { ref: first, status: 'needs_reauth' as const };
        const usable = { ref: current, status: 'refreshing' as const };
        const inventory = { accounts: [signedOut, usable] };
        expect(resolveConnectSheetOpening({ service }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: usable.ref });
        expect(resolveConnectSheetOpening({ service, account: signedOut.ref }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: usable.ref });
        expect(resolveConnectSheetOpening({ service }, { accounts: [signedOut] }))
            .toMatchObject({ initialMode: 'new', preselected: null });
    });

    it('matches declared purpose services without choosing an unrelated service for the generic catalog', () => {
        const accounts = [{ service: otherService, accountId: 'forge' }, first].map(ref => ({ ref, status: 'connected' as const }));
        expect(resolveConnectSheetOpening({ purpose: { consumer: service, purpose: 'model-access' } }, { accounts, services: [service] }))
            .toMatchObject({ initialMode: 'saved', preselected: first });
        expect(resolveConnectSheetOpening({}, { accounts }))
            .toMatchObject({ initialMode: 'new', preselected: null });
    });

    it('prefers the key already bound to this target elsewhere over a generic matching type', () => {
        const keys = [{ ref: 'generic-api-key', kind: 'apiKey' as const },
            { ref: 'deepseek-elsewhere', kind: 'other' as const }, { ref: 'current-link', kind: 'apiKey' as const }];
        const request = { service: { kind: 'key' as const, keyKind: 'apiKey' as const } };
        const inventory = { keys, sameTargetRefs: ['deepseek-elsewhere'] };
        expect(resolveConnectSheetOpening(request, inventory)).toMatchObject({ initialMode: 'saved', preselected: 'deepseek-elsewhere' });
        expect(resolveConnectSheetOpening({ ...request, current: 'current-link' }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: 'current-link' });
    });

    it('opens New when the Account has no matching credential', () => {
        expect(resolveConnectSheetOpening({ service }, { accounts: [{ ref: { service: otherService, accountId: 'forge' } }] }))
            .toMatchObject({ initialMode: 'new', preselected: null });
        expect(resolveConnectSheetOpening({ service: { kind: 'key', keyKind: 'apiKey' } }, { keys: [] }))
            .toMatchObject({ initialMode: 'new', preselected: null });
    });

    it('keeps kind-only matches available without opening Saved, while the current link selects Saved', () => {
        const keys = [{ ref: 'unrelated-password', kind: 'password' as const },
            { ref: 'first-api-key', kind: 'apiKey' as const }, { ref: 'linked-api-key', kind: 'apiKey' as const }];
        const request = { service: { kind: 'key' as const, keyKind: 'apiKey' as const } };
        expect(resolveConnectSheetOpening(request, { keys: keys.slice(0, 1) }))
            .toMatchObject({ initialMode: 'new', preselected: null });
        expect(resolveConnectSheetOpening(request, { keys }))
            .toMatchObject({ initialMode: 'new', preselected: null, savedKeys: keys.slice(1) });
        expect(resolveConnectSheetOpening({ ...request, current: 'linked-api-key' }, { keys }))
            .toMatchObject({ initialMode: 'saved', preselected: 'linked-api-key' });
    });
    it('opens Credentials explicit add intent on New while matching accounts remain available', () => {
        const inventory = { accounts: [{ ref: current, status: 'connected' as const }] };
        expect(resolveConnectSheetOpening({ service, intent: 'add' }, inventory))
            .toMatchObject({ initialMode: 'new', preselected: null });
        expect(resolveConnectSheetOpening({ service }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: current });
    });

    it('returns the ranked eligible key list without filtering out demonstrated current or same-target links', () => {
        const keys = [
            { ref: 'unrelated-password', kind: 'password' as const },
            { ref: 'generic-api-key', kind: 'apiKey' as const },
            { ref: 'same-target', kind: 'other' as const },
            { ref: 'current-link', kind: 'token' as const },
            { ref: 'another-api-key', kind: 'apiKey' as const },
        ];
        expect(resolveConnectSheetOpening({ service: { kind: 'key', keyKind: 'apiKey' }, current: 'current-link' },
            { keys, sameTargetRefs: ['same-target'] })).toEqual({ initialMode: 'saved', preselected: 'current-link',
                savedKeys: [keys[3], keys[2], keys[1], keys[4]] });
        expect(resolveConnectSheetOpening({ service: { kind: 'key' } }, { keys: keys.slice(0, 1) }))
            .toEqual({ initialMode: 'new', preselected: null, savedKeys: keys.slice(0, 1) });
        expect(resolveConnectSheetOpening({ service: { kind: 'key', keyKind: 'apiKey' } }, { keys: keys.slice(0, 1) }))
            .toEqual({ initialMode: 'new', preselected: null, savedKeys: [] });
    });

});
