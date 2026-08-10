import { describe, expect, it, vi } from 'vitest';

import {
    HAPPIER_SKILL_MENTIONS_METADATA_KEY,
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY,
    MENTION_KIND_V1,
    buildMentionRefForKindV1,
} from '@happier-dev/protocol';

import { buildCodexAppServerTurnInput } from '@/backends/codex/appServer/turnInput';
import {
    StructuredInputMentionResolutionError,
    resolveStructuredInputProviderContextInMeta,
} from './resolveStructuredInputProviderContext';

/**
 * The catalogs exactly as the Codex app server surfaces them
 * (`backends/codex/appServer/pluginAndSkillCatalog.ts` — `{ supported, skills }` /
 * `{ supported, vendorPlugins }`, skills carrying the legacy `codex_native` origin and no id).
 */
const SKILL_ITEM = {
    name: 'review',
    displayName: 'Review',
    description: 'Review a diff',
    path: '/w/.codex/skills/review/SKILL.md',
    enabled: true,
    origin: 'codex_native',
} as const;

const OTHER_SKILL_ITEM = {
    name: 'plan',
    displayName: 'Plan',
    path: '/w/.codex/skills/plan/SKILL.md',
    enabled: true,
    origin: 'codex_native',
} as const;

const VENDOR_ITEM = {
    id: 'plugin://linear@happier',
    name: 'linear',
    displayName: 'Linear',
    description: 'Linear issues',
    vendorPluginRef: 'plugin://linear@happier',
    installed: true,
    enabled: true,
    mentionable: true,
} as const;

const SKILL_REF = buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review');
const VENDOR_REF = buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, VENDOR_ITEM.vendorPluginRef);

const TEXT = 'run $review with @linear';

function catalogs(overrides: Partial<{ listSkills: () => Promise<unknown>; listVendorPlugins: () => Promise<unknown> }> = {}) {
    return {
        listSkills: async () => ({ supported: true, skills: [OTHER_SKILL_ITEM, SKILL_ITEM] }),
        listVendorPlugins: async () => ({ supported: true, vendorPlugins: [VENDOR_ITEM] }),
        ...overrides,
    };
}

function metaWithMentions(mentions: readonly Record<string, unknown>[]): Record<string, unknown> {
    return { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { v: 1, mentions } };
}

const SKILL_MENTION = { kind: MENTION_KIND_V1.skill, ref: SKILL_REF, token: '$review', start: 4, end: 11 };
const VENDOR_MENTION = { kind: MENTION_KIND_V1.vendorPlugin, ref: VENDOR_REF, token: '@linear', start: 17, end: 24 };

/**
 * The legacy envelope the composer writes today for the same two selections — the control
 * R-10 measures against.
 */
const LEGACY_META = {
    [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
        v: 1,
        skillMentions: [{
            name: 'review',
            path: '/w/.codex/skills/review/SKILL.md',
            displayName: 'Review',
            description: 'Review a diff',
            origin: 'codex_native',
        }],
        vendorPluginMentions: [{ vendorPluginRef: 'plugin://linear@happier', label: 'Linear' }],
    },
};

describe('resolveStructuredInputProviderContextInMeta', () => {
    it('produces the same Codex turn input from mentions[] alone as the legacy arrays do (R-10)', async () => {
        const resolved = await resolveStructuredInputProviderContextInMeta({
            meta: metaWithMentions([SKILL_MENTION, VENDOR_MENTION]),
            catalogs: catalogs(),
        });

        const fromMentions = buildCodexAppServerTurnInput({ text: TEXT, metadata: resolved });
        const fromLegacy = buildCodexAppServerTurnInput({ text: TEXT, metadata: LEGACY_META });

        expect(fromMentions).toEqual(fromLegacy);
        expect(fromMentions).toEqual([
            { type: 'text', text: TEXT },
            { type: 'mention', name: 'Linear', path: 'plugin://linear@happier' },
            { type: 'skill', name: 'review', path: '/w/.codex/skills/review/SKILL.md' },
        ]);
    });

    it('reconstructs the skill path the reference never carried', async () => {
        // The failure this whole unit exists to prevent: `turnInput.ts` drops any skill item
        // lacking BOTH name and path, and `MentionRefV1` carries neither.
        const unresolved = buildCodexAppServerTurnInput({ text: TEXT, metadata: metaWithMentions([SKILL_MENTION]) });
        expect(unresolved).toEqual([{ type: 'text', text: TEXT }]);

        const resolved = await resolveStructuredInputProviderContextInMeta({
            meta: metaWithMentions([SKILL_MENTION]),
            catalogs: catalogs(),
        });
        expect(buildCodexAppServerTurnInput({ text: TEXT, metadata: resolved })).toEqual([
            { type: 'text', text: TEXT },
            { type: 'skill', name: 'review', path: '/w/.codex/skills/review/SKILL.md' },
        ]);
    });

    it('emits one provider item per unique {kind, ref} in first-occurrence order (D-26)', async () => {
        const resolved = await resolveStructuredInputProviderContextInMeta({
            meta: metaWithMentions([
                { kind: MENTION_KIND_V1.skill, ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:plan'), token: '$plan', start: 0, end: 5 },
                SKILL_MENTION,
                { ...SKILL_MENTION, start: 30, end: 37 },
            ]),
            catalogs: catalogs(),
        });

        expect(buildCodexAppServerTurnInput({ text: TEXT, metadata: resolved })).toEqual([
            { type: 'text', text: TEXT },
            { type: 'skill', name: 'plan', path: '/w/.codex/skills/plan/SKILL.md' },
            { type: 'skill', name: 'review', path: '/w/.codex/skills/review/SKILL.md' },
        ]);
    });

    it('rejects the send when the catalog positively lacks a referenced skill (D-27)', async () => {
        await expect(resolveStructuredInputProviderContextInMeta({
            meta: metaWithMentions([{
                ...SKILL_MENTION,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:deleted'),
            }]),
            catalogs: catalogs(),
        })).rejects.toBeInstanceOf(StructuredInputMentionResolutionError);
    });

    it('never reports an unreadable catalog as a missing reference (D-27)', async () => {
        for (const listSkills of [
            async () => ({ supported: false, skills: [] }),
            async () => ({ unsupported: true, skills: [] }),
            async () => { throw new Error('rpc failed'); },
            async () => 'not a catalog',
        ]) {
            const diagnostics: unknown[] = [];
            const resolved = await resolveStructuredInputProviderContextInMeta({
                meta: metaWithMentions([SKILL_MENTION]),
                catalogs: catalogs({ listSkills }),
                onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
            });
            expect(buildCodexAppServerTurnInput({ text: TEXT, metadata: resolved })).toEqual([{ type: 'text', text: TEXT }]);
            expect(diagnostics).toHaveLength(1);
        }
    });

    it('leaves a message without mentions[] byte-identical and reads no catalog', async () => {
        const listSkills = vi.fn(async () => ({ supported: true, skills: [SKILL_ITEM] }));
        const listVendorPlugins = vi.fn(async () => ({ supported: true, vendorPlugins: [VENDOR_ITEM] }));

        const resolved = await resolveStructuredInputProviderContextInMeta({
            meta: LEGACY_META,
            catalogs: { listSkills, listVendorPlugins },
        });

        expect(resolved).toBe(LEGACY_META);
        expect(listSkills).not.toHaveBeenCalled();
        expect(listVendorPlugins).not.toHaveBeenCalled();
    });

    it('reads no catalog when mentions[] carries only kinds that produce no provider item', async () => {
        const listSkills = vi.fn(async () => ({ supported: true, skills: [SKILL_ITEM] }));
        const listVendorPlugins = vi.fn(async () => ({ supported: true, vendorPlugins: [VENDOR_ITEM] }));

        const resolved = await resolveStructuredInputProviderContextInMeta({
            meta: metaWithMentions([
                { kind: MENTION_KIND_V1.file, ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, 'src/a.ts'), token: '@src/a.ts', start: 0, end: 9 },
                { kind: 'acme.widget', ref: 'widget:42', token: '@widget', start: 10, end: 17 },
            ]),
            catalogs: { listSkills, listVendorPlugins },
        });

        expect(buildCodexAppServerTurnInput({ text: TEXT, metadata: resolved })).toEqual([{ type: 'text', text: TEXT }]);
        expect(listSkills).not.toHaveBeenCalled();
        expect(listVendorPlugins).not.toHaveBeenCalled();
    });

    it('never reinterprets a reference whose scheme does not match its kind', async () => {
        const resolved = await resolveStructuredInputProviderContextInMeta({
            meta: metaWithMentions([{
                ...SKILL_MENTION,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'vendor:codex:review'),
            }]),
            catalogs: catalogs(),
        });
        expect(buildCodexAppServerTurnInput({ text: TEXT, metadata: resolved })).toEqual([{ type: 'text', text: TEXT }]);
    });

    it('drops the legacy arrays and meta-root aliases D-4 had already ruled out', async () => {
        const resolved = await resolveStructuredInputProviderContextInMeta({
            meta: {
                [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
                    v: 1,
                    mentions: [VENDOR_MENTION],
                    skillMentions: [{ name: 'stale', path: '/stale/SKILL.md' }],
                },
                [HAPPIER_SKILL_MENTIONS_METADATA_KEY]: [{ name: 'alias', path: '/alias/SKILL.md' }],
                [HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY]: [{ vendorPluginRef: 'plugin://alias@happier' }],
            },
            catalogs: catalogs(),
        });

        expect(buildCodexAppServerTurnInput({ text: TEXT, metadata: resolved })).toEqual([
            { type: 'text', text: TEXT },
            { type: 'mention', name: 'Linear', path: 'plugin://linear@happier' },
        ]);
    });

    it('preserves the attachments the envelope carries alongside references', async () => {
        const resolved = await resolveStructuredInputProviderContextInMeta({
            meta: {
                [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
                    v: 1,
                    mentions: [VENDOR_MENTION],
                    attachments: [{ kind: 'image', url: 'https://example.test/a.png' }],
                },
            },
            catalogs: catalogs(),
        });

        expect(buildCodexAppServerTurnInput({ text: TEXT, metadata: resolved })).toEqual([
            { type: 'text', text: TEXT },
            { type: 'mention', name: 'Linear', path: 'plugin://linear@happier' },
            { type: 'image', url: 'https://example.test/a.png' },
        ]);
    });
});
