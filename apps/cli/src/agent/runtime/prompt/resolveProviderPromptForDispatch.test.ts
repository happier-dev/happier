import { describe, expect, it, vi } from 'vitest';

import {
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    MENTION_BOUNDS,
    MENTION_KIND_V1,
    buildMentionRefForKindV1,
} from '@happier-dev/protocol';

import {
    ResolvedMentionContextTooLargeError,
    resolveProviderPromptForDispatch,
} from './resolveProviderPromptForDispatch';
import { configuration } from '@/configuration';

/**
 * D-27's total bound, at the one prompt-finalization owner.
 *
 * `maxReferenceBlockChars` bounds the session text block on its own; `maxResolvedContextChars`
 * bounds the SUM of all resolved reference context in one message, across kinds. A message whose
 * total exceeds it is rejected rather than having user-selected references silently truncated.
 */

const SESSION_REF = buildMentionRefForKindV1(MENTION_KIND_V1.session, 'sess-referenced-1');
const SKILL_REF = buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review');

function skillCatalog(description: string) {
    return {
        listSkills: async () => ({
            supported: true,
            skills: [{
                name: 'review',
                displayName: 'Review',
                description,
                path: '/w/.codex/skills/review/SKILL.md',
                enabled: true,
                origin: 'codex_native',
            }],
        }),
    };
}

function metaWith(mentions: readonly Record<string, unknown>[]): Record<string, unknown> {
    return { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { v: 1, mentions } };
}

const SESSION_MENTION = {
    kind: MENTION_KIND_V1.session,
    ref: SESSION_REF,
    token: '@session:referenced-abc123',
    label: 'The referenced session',
    start: 0,
    end: 26,
};

const SKILL_MENTION = { kind: MENTION_KIND_V1.skill, ref: SKILL_REF, token: '$review', start: 27, end: 34 };

/**
 * A session whose metadata carries an UNAPPLIED replay seed, so that
 * `resolveProviderPromptWithReplaySeed` would really consume it (`updateMetadata`) if it ran.
 * With an empty snapshot there is no seed to burn, and "the seed was not burned" is true of
 * every possible implementation.
 */
function createSession(opts: Readonly<{ withPendingSeed?: boolean }> = {}) {
    const updateMetadata = vi.fn();
    const metadata = opts.withPendingSeed
        ? {
            replaySeedV1: {
                v: 1,
                seedText: 'previously replayed transcript',
                sourceSessionId: 'sess-source-1',
                sourceCutoffSeqInclusive: 7,
                createdAtMs: 500,
            },
        }
        : {};
    return {
        updateMetadata,
        session: {
            getMetadataSnapshot: () => metadata,
            updateMetadata,
        },
    };
}

async function dispatch(params: Readonly<{ meta: unknown; description?: string }>) {
    const { session, updateMetadata } = createSession();
    const resolution = await resolveProviderPromptForDispatch({
        session,
        userText: 'do the thing',
        allowSeed: false,
        localId: 'local-1',
        nowMs: 1_000,
        refreshMetadataBeforeRead: false,
        meta: params.meta,
        ...(params.description === undefined ? {} : { catalogs: skillCatalog(params.description) }),
    });
    return { resolution, updateMetadata };
}

describe('resolveProviderPromptForDispatch — D-27 total resolved-context bound', () => {
    it('rejects the send when one kind alone exceeds the total bound', async () => {
        // A single skill whose resolved provider context is larger than the whole message budget.
        await expect(dispatch({
            meta: metaWith([SKILL_MENTION]),
            description: 'x'.repeat(MENTION_BOUNDS.maxResolvedContextChars + 50),
        })).rejects.toBeInstanceOf(ResolvedMentionContextTooLargeError);
    });

    it('rejects on the SUM across kinds, when no single kind exceeds the bound', async () => {
        // The deciding case: neither the session block nor the resolved skill context is over the
        // bound by itself, so a per-kind implementation would let this through.
        const description = 'y'.repeat(MENTION_BOUNDS.maxResolvedContextChars - 400);
        const skillOnly = await dispatch({ meta: metaWith([SKILL_MENTION]), description });
        expect(skillOnly.resolution.providerPrompt).toContain('do the thing');

        const sessionOnly = await dispatch({ meta: metaWith([SESSION_MENTION]) });
        const block = sessionOnly.resolution.providerPrompt.slice('do the thing\n\n'.length);
        expect(block.length).toBeLessThanOrEqual(MENTION_BOUNDS.maxResolvedContextChars);

        await expect(dispatch({
            meta: metaWith([SESSION_MENTION, SKILL_MENTION]),
            description,
        })).rejects.toBeInstanceOf(ResolvedMentionContextTooLargeError);
    });

    it('carries a typed, actionable code and the measured totals', async () => {
        const error = await dispatch({
            meta: metaWith([SKILL_MENTION]),
            description: 'z'.repeat(MENTION_BOUNDS.maxResolvedContextChars + 50),
        }).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(ResolvedMentionContextTooLargeError);
        const typed = error as ResolvedMentionContextTooLargeError;
        expect(typed.code).toBe('mention_resolved_context_too_large');
        expect(typed.maxChars).toBe(MENTION_BOUNDS.maxResolvedContextChars);
        expect(typed.totalChars).toBeGreaterThan(MENTION_BOUNDS.maxResolvedContextChars);
    });

    it('does not burn the replay seed on a rejected send', async () => {
        // Positive control FIRST: with the same pending seed, an ADMITTED send retires it once the
        // provider accepts. Without this, "not called" would also be satisfied by a session that
        // has no seed to burn.
        const admitted = createSession({ withPendingSeed: true });
        const admittedResolution = await resolveProviderPromptForDispatch({
            session: admitted.session,
            userText: 'do the thing',
            allowSeed: true,
            localId: 'local-1',
            nowMs: 1_000,
            refreshMetadataBeforeRead: false,
            meta: metaWith([SKILL_MENTION]),
            catalogs: skillCatalog('Review a diff'),
        });
        expect(admittedResolution.seedApplied).toBe(true);
        expect(admitted.updateMetadata).not.toHaveBeenCalled();
        await admittedResolution.settleReplaySeedOnProviderAcceptance();
        expect(admitted.updateMetadata).toHaveBeenCalledTimes(1);

        const { session, updateMetadata } = createSession({ withPendingSeed: true });
        await expect(resolveProviderPromptForDispatch({
            session,
            userText: 'do the thing',
            allowSeed: true,
            localId: 'local-1',
            nowMs: 1_000,
            refreshMetadataBeforeRead: false,
            meta: metaWith([SKILL_MENTION]),
            catalogs: skillCatalog('q'.repeat(MENTION_BOUNDS.maxResolvedContextChars + 50)),
        })).rejects.toBeInstanceOf(ResolvedMentionContextTooLargeError);
        expect(updateMetadata).not.toHaveBeenCalled();
    });

    it('admits a message whose total resolved context is inside the bound', async () => {
        const { resolution } = await dispatch({
            meta: metaWith([SESSION_MENTION, SKILL_MENTION]),
            description: 'Review a diff',
        });

        expect(resolution.providerPrompt).toContain('<happier_session_reference>');
        expect(resolution.providerPrompt).toContain('sess-referenced-1');
        const envelope = (resolution.meta as Record<string, any>)[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
        expect(envelope.skillMentions).toEqual([expect.objectContaining({ name: 'review' })]);
    });

    it('spends ONE total on the replay seed and the Session-reference block together', async () => {
        // The seed's cap is enforced when the seed is built; the reference block is appended
        // here. Without one shared total the prompt exceeds the configured seed cap by up to
        // the reference bound every time a replayed session carries an @session mention.
        const { session } = createSession({ withPendingSeed: true });
        const oversizedSeed = 'S'.repeat(configuration.replaySeedMaxChars);
        session.getMetadataSnapshot = () => ({
            replaySeedV1: {
                v: 1,
                seedText: oversizedSeed,
                sourceSessionId: 'sess-source-1',
                sourceCutoffSeqInclusive: 7,
                createdAtMs: 500,
            },
        });

        const resolution = await resolveProviderPromptForDispatch({
            session,
            userText: 'do the thing',
            allowSeed: true,
            localId: 'local-1',
            nowMs: 1_000,
            refreshMetadataBeforeRead: false,
            meta: metaWith([SESSION_MENTION]),
        });

        expect(resolution.seedApplied).toBe(true);
        expect(resolution.providerPrompt).toContain('<happier_session_reference>');
        expect(resolution.providerPrompt).toContain('sess-referenced-1');
        // The seed plus the reference block fit the single configured total. The user's own
        // message is not part of that budget, so it and its joiner are removed before measuring.
        const brief = resolution.providerPrompt.replace('\n\ndo the thing\n\n', '\n\n');
        expect(brief.length).toBeLessThanOrEqual(configuration.replaySeedMaxChars);
        // The loss is stated, never silent.
        expect(resolution.providerPrompt).toContain('omitted to fit the replay budget');
    });

    it('leaves the reference block whole and does not touch a prompt with no applied seed', async () => {
        const { session } = createSession();
        const resolution = await resolveProviderPromptForDispatch({
            session,
            userText: 'do the thing',
            allowSeed: true,
            localId: 'local-1',
            nowMs: 1_000,
            refreshMetadataBeforeRead: false,
            meta: metaWith([SESSION_MENTION]),
        });

        expect(resolution.seedApplied).toBe(false);
        expect(resolution.providerPrompt.startsWith('do the thing\n\n<happier_session_reference>')).toBe(true);
        expect(resolution.providerPrompt).toContain('sess-referenced-1');
    });

    it('leaves a message with no references unbounded and unmeasured (legacy path untouched)', async () => {
        // A legacy message carries provider context that resolution never produced. D-27 bounds
        // RESOLVED context, so a legacy envelope larger than the bound must still dispatch.
        const legacyMeta = {
            [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
                v: 1,
                skillMentions: [{
                    name: 'review',
                    path: '/w/.codex/skills/review/SKILL.md',
                    description: 'l'.repeat(MENTION_BOUNDS.maxResolvedContextChars + 50),
                }],
            },
        };
        const { resolution } = await dispatch({ meta: legacyMeta });
        expect(resolution.meta).toBe(legacyMeta);
        expect(resolution.providerPrompt).toBe('do the thing');
    });
});
