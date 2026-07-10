import { describe, expect, it } from 'vitest';

import {
    normalizeConnectedServiceSelectionForRunStart,
    normalizeConnectedServiceSelectionInput,
} from './normalizeConnectedServiceSelectionInput.js';

describe('normalizeConnectedServiceSelectionInput', () => {
    it('treats undefined/null/empty array as no explicit selection (account default)', () => {
        expect(normalizeConnectedServiceSelectionInput(undefined)).toEqual({
            ok: true,
            bindings: undefined,
            defaultServiceIds: [],
        });
        expect(normalizeConnectedServiceSelectionInput(null)).toEqual({
            ok: true,
            bindings: undefined,
            defaultServiceIds: [],
        });
        expect(normalizeConnectedServiceSelectionInput([])).toEqual({
            ok: true,
            bindings: undefined,
            defaultServiceIds: [],
        });
    });

    it('represents a bare service id as an explicit per-service default (never dropped)', () => {
        // Root-cause fix (RO-F5): the bare token is the NAMED service asking for its account default —
        // it must be represented explicitly, not collapsed into whole-request absence.
        expect(normalizeConnectedServiceSelectionInput('openai-codex')).toEqual({
            ok: true,
            bindings: undefined,
            defaultServiceIds: ['openai-codex'],
        });
    });

    it('normalizes "<service>:<profileId>" to a profile binding', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:team');
        expect(result).toEqual({
            ok: true,
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
                },
            },
            defaultServiceIds: [],
        });
    });

    it('normalizes the explicit "<service>:profile:<profileId>" form', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:profile:team');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'team',
        });
    });

    it('preserves colons inside a profile id for the explicit form (RO-F6)', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:profile:work:us');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'work:us',
        });
    });

    it('preserves colons inside a profile id for the shorthand form (RO-F6)', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:work:us');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'work:us',
        });
    });

    it('normalizes "<service>:group:<groupId>" to a group binding', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:group:happier');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
        });
    });

    it('keeps group ids strict — a colon in a group token is rejected (RO-F6)', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:group:bad:group');
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/group id/i);
    });

    it('normalizes "<service>:native" to a native (opt-out) binding', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:native');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({ source: 'native' });
    });

    it('accepts an array of tokens across services', () => {
        const result = normalizeConnectedServiceSelectionInput(['openai-codex:group:happier', 'anthropic:work']);
        expect(result.ok).toBe(true);
        expect(result.ok && Object.keys(result.bindings?.bindingsByServiceId ?? {})).toEqual(['openai-codex', 'anthropic']);
        expect(result.ok && result.defaultServiceIds).toEqual([]);
    });

    it('represents a mixed bare + explicit selection without dropping the bare service (RO-F5)', () => {
        const result = normalizeConnectedServiceSelectionInput(['openai-codex', 'anthropic:work']);
        expect(result.ok).toBe(true);
        // anthropic is an explicit binding; openai-codex is represented as a per-service default.
        expect(result.ok && Object.keys(result.bindings?.bindingsByServiceId ?? {})).toEqual(['anthropic']);
        expect(result.ok && result.defaultServiceIds).toEqual(['openai-codex']);
    });

    it('rejects a bare + explicit selection for the SAME service as a duplicate (RO-F5)', () => {
        const result = normalizeConnectedServiceSelectionInput(['openai-codex', 'openai-codex:group:happier']);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/Duplicate selection/);
    });

    it('accepts the full bindings object power form', () => {
        const input = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
            },
        };
        expect(normalizeConnectedServiceSelectionInput(input)).toEqual({
            ok: true,
            bindings: input,
            defaultServiceIds: [],
        });
    });

    it('rejects an unknown service id with a typed error naming the valid forms', () => {
        const result = normalizeConnectedServiceSelectionInput('not-a-service:team');
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/Unknown connected service id/);
        expect(result.ok === false && result.error).toMatch(/<serviceId>:group:<groupId>/);
    });

    it('rejects a group form missing its group id', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:group');
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/missing a group id/);
    });

    it('rejects a trailing-colon malformed string', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:');
        expect(result.ok).toBe(false);
    });

    it('rejects duplicate selections for the same service', () => {
        const result = normalizeConnectedServiceSelectionInput(['openai-codex:team', 'openai-codex:group:happier']);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/Duplicate selection/);
    });

    it('rejects a malformed object', () => {
        const result = normalizeConnectedServiceSelectionInput({ nope: true });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/Invalid connected-services object/);
    });
});

describe('normalizeConnectedServiceSelectionForRunStart (settings-less boundary policy)', () => {
    it('passes explicit-only selections through as canonical bindings', () => {
        const result = normalizeConnectedServiceSelectionForRunStart('openai-codex:group:happier');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
        });
    });

    it('defers a pure bare-default selection to downstream account defaulting (no bindings)', () => {
        const result = normalizeConnectedServiceSelectionForRunStart('openai-codex');
        expect(result).toEqual({ ok: true, bindings: undefined });
    });

    it('fails closed on a mixed bare-default + explicit selection instead of silently dropping the bare service (RO-F5)', () => {
        const result = normalizeConnectedServiceSelectionForRunStart(['openai-codex', 'anthropic:work']);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/cannot be combined/i);
        expect(result.ok === false && result.error).toMatch(/openai-codex/);
    });

    it('propagates a malformed selection error unchanged', () => {
        const result = normalizeConnectedServiceSelectionForRunStart('not-a-service:team');
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/Unknown connected service id/);
    });
});
