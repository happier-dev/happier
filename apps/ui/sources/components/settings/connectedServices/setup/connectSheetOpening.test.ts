import { describe, expect, it } from 'vitest';
import { isConnectSheetKeyRequest, isConnectSheetNpmRegistryRequest, resolveConnectSheetOpening, resolveConnectSheetTarget } from './connectSheetOpening';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const otherService = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
const first = { service, accountId: 'personal' };
const current = { service, accountId: 'work' };

describe('Connect sheet opening choice', () => {
    it('opens the one way to connect directly instead of a catalog of one, and keeps a real choice', () => {
        const vercel = { serviceKey: 'happier.deploy.vercel/vercel-account', canAdd: true };
        const github = { serviceKey: 'happier.scm.forge.github/github-account', canAdd: true };
        expect(resolveConnectSheetTarget({ kind: 'catalog' }, [vercel])).toEqual({ kind: 'service', serviceKey: vercel.serviceKey });
        expect(resolveConnectSheetTarget({ kind: 'catalog' }, [vercel, github])).toEqual({ kind: 'catalog' });
        // A service that cannot add an account here stays in the catalog, where it says why.
        expect(resolveConnectSheetTarget({ kind: 'catalog' }, [{ ...vercel, canAdd: false }])).toEqual({ kind: 'catalog' });
        const chosen = { kind: 'service' as const, serviceKey: github.serviceKey };
        expect(resolveConnectSheetTarget(chosen, [vercel])).toBe(chosen);
    });

    it('routes npm profiles to their Machine owner rather than Saved Secrets', () => {
        const request = { service: { kind: 'npm-registry-profile' as const } };
        expect(isConnectSheetKeyRequest(request)).toBe(false);
        expect(isConnectSheetNpmRegistryRequest(request)).toBe(true);
    });
    it('opens Saved for the same service and prefers the caller’s current account', () => {
        expect(resolveConnectSheetOpening({ intent: 'link', service, account: current }, { accounts: [first, current].map(ref => ({ ref, status: 'connected' as const })) }))
            .toMatchObject({ initialMode: 'saved', preselected: current });
        expect(resolveConnectSheetOpening({ intent: 'link', service }, { accounts: [first, current].map(ref => ({ ref, status: 'connected' as const })) }))
            .toMatchObject({ initialMode: 'saved', preselected: first });
    });

    it('never preselects a signed-out account, including the current link or an all-signed-out inventory', () => {
        const signedOut = { ref: first, status: 'needs_reauth' as const };
        const usable = { ref: current, status: 'refreshing' as const };
        const inventory = { accounts: [signedOut, usable] };
        expect(resolveConnectSheetOpening({ intent: 'link', service }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: usable.ref });
        expect(resolveConnectSheetOpening({ intent: 'link', service, account: signedOut.ref }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: usable.ref });
        expect(resolveConnectSheetOpening({ intent: 'link', service }, { accounts: [signedOut] }))
            .toMatchObject({ initialMode: 'new', preselected: null });
    });

    it('matches declared purpose services without choosing an unrelated service for the generic catalog', () => {
        const accounts = [{ service: otherService, accountId: 'forge' }, first].map(ref => ({ ref, status: 'connected' as const }));
        expect(resolveConnectSheetOpening({ intent: 'link', purpose: { consumer: service, purpose: 'model-access' } }, { accounts, services: [service] }))
            .toMatchObject({ initialMode: 'saved', preselected: first });
        expect(resolveConnectSheetOpening({ intent: 'link' }, { accounts }))
            .toMatchObject({ initialMode: 'new', preselected: null });
    });

    it('prefers the key already bound to this target elsewhere over a generic matching type', () => {
        const keys = [{ ref: 'generic-api-key', kind: 'apiKey' as const },
            { ref: 'deepseek-elsewhere', kind: 'other' as const }, { ref: 'current-link', kind: 'apiKey' as const }];
        const request = { service: { kind: 'key' as const, keyKind: 'apiKey' as const }, intent: 'link' as const };
        const inventory = { keys, sameTargetRefs: ['deepseek-elsewhere'] };
        expect(resolveConnectSheetOpening(request, inventory)).toMatchObject({ initialMode: 'saved', preselected: 'deepseek-elsewhere' });
        expect(resolveConnectSheetOpening({ ...request, current: 'current-link' }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: 'current-link' });
    });

    it('opens New when the Account has no matching credential', () => {
        expect(resolveConnectSheetOpening({ intent: 'link', service }, { accounts: [{ ref: { service: otherService, accountId: 'forge' } }] }))
            .toMatchObject({ initialMode: 'new', preselected: null });
        expect(resolveConnectSheetOpening({ intent: 'link', service: { kind: 'key', keyKind: 'apiKey' } }, { keys: [] }))
            .toMatchObject({ initialMode: 'new', preselected: null });
    });

    it('opens requested keys on Saved without guessing which unrelated key to use', () => {
        const keys = [{ ref: 'unrelated-password', kind: 'password' as const },
            { ref: 'first-api-key', kind: 'apiKey' as const }, { ref: 'linked-api-key', kind: 'apiKey' as const }];
        const request = { service: { kind: 'key' as const, keyKind: 'apiKey' as const }, intent: 'link' as const };
        expect(resolveConnectSheetOpening(request, { keys: keys.slice(0, 1) }))
            .toMatchObject({ initialMode: 'new', preselected: null });
        expect(resolveConnectSheetOpening(request, { keys }))
            .toMatchObject({ initialMode: 'saved', preselected: null, savedKeys: keys.slice(1) });
        expect(resolveConnectSheetOpening({ ...request, current: 'linked-api-key' }, { keys }))
            .toMatchObject({ initialMode: 'saved', preselected: 'linked-api-key' });
    });
    // Owner 2026-11-11 (OWNER-1357-CONNECT 04): adding offers only the new-account form; linking offers what exists.
    it('offers existing accounts and keys only when linking, never when adding', () => {
        const inventory = { accounts: [{ ref: current, status: 'connected' as const }] };
        expect(resolveConnectSheetOpening({ service, intent: 'add' }, inventory))
            .toEqual({ initialMode: 'new', preselected: null, offerSaved: false });
        expect(resolveConnectSheetOpening({ service, intent: 'link' }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: current, offerSaved: true });
        const keys = [{ ref: 'saved-key', kind: 'apiKey' as const }];
        expect(resolveConnectSheetOpening({ service: { kind: 'key' }, intent: 'add' }, { keys }))
            .toEqual({ initialMode: 'new', preselected: null, offerSaved: false, savedKeys: [] });
        expect(resolveConnectSheetOpening({ service: { kind: 'key' }, intent: 'link' }, { keys }))
            .toMatchObject({ initialMode: 'saved', offerSaved: true, savedKeys: keys });
    });

    it('offers an existing but signed-out account to link, without preselecting it', () => {
        expect(resolveConnectSheetOpening({ service, intent: 'link' }, { accounts: [{ ref: first, status: 'needs_reauth' as const }] }))
            .toEqual({ initialMode: 'new', preselected: null, offerSaved: true });
    });

    it('returns the ranked eligible key list without filtering out demonstrated current or same-target links', () => {
        const keys = [
            { ref: 'unrelated-password', kind: 'password' as const },
            { ref: 'generic-api-key', kind: 'apiKey' as const },
            { ref: 'same-target', kind: 'other' as const },
            { ref: 'current-link', kind: 'token' as const },
            { ref: 'another-api-key', kind: 'apiKey' as const },
        ];
        expect(resolveConnectSheetOpening({ intent: 'link', service: { kind: 'key', keyKind: 'apiKey' }, current: 'current-link' },
            { keys, sameTargetRefs: ['same-target'] })).toEqual({ initialMode: 'saved', preselected: 'current-link', offerSaved: true,
                savedKeys: [keys[3], keys[2], keys[1], keys[4]] });
        expect(resolveConnectSheetOpening({ intent: 'link', service: { kind: 'key' } }, { keys: keys.slice(0, 1) }))
            .toEqual({ initialMode: 'saved', preselected: null, offerSaved: true, savedKeys: keys.slice(0, 1) });
        expect(resolveConnectSheetOpening({ intent: 'link', service: { kind: 'key', keyKind: 'apiKey' } }, { keys: keys.slice(0, 1) }))
            .toEqual({ initialMode: 'new', preselected: null, offerSaved: false, savedKeys: [] });
    });

});
