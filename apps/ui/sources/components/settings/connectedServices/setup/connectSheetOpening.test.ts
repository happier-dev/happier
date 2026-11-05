import { describe, expect, it } from 'vitest';
import { resolveConnectSheetOpening } from './connectSheetOpening';

describe('Connect sheet key opening choice', () => {
    it('prefers the key already bound to this target elsewhere over a generic matching type', () => {
        const keys = [{ ref: 'generic-api-key', kind: 'apiKey' as const },
            { ref: 'deepseek-elsewhere', kind: 'other' as const }, { ref: 'current-link', kind: 'apiKey' as const }];
        const request = { service: { kind: 'key' as const, keyKind: 'apiKey' as const } };
        const inventory = { keys, sameTargetRefs: ['deepseek-elsewhere'] };
        expect(resolveConnectSheetOpening(request, inventory)).toMatchObject({ initialMode: 'saved', preselected: 'deepseek-elsewhere' });
        expect(resolveConnectSheetOpening({ ...request, current: 'current-link' }, inventory))
            .toMatchObject({ initialMode: 'saved', preselected: 'current-link' });
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
