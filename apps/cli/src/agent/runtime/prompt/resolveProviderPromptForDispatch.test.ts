import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import {
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    MENTION_BOUNDS,
    MENTION_KIND_V1,
    buildMentionRefForKindV1,
} from '@happier-dev/protocol';

import { buildHappierReplayPromptFromDialog } from '@happier-dev/agents';

import {
    ResolvedMentionContextTooLargeError,
    resolveProviderPromptForDispatch,
} from './resolveProviderPromptForDispatch';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

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
function createSession(opts: Readonly<{ withPendingSeed?: boolean; seedText?: string }> = {}) {
    const updateMetadata = vi.fn();
    const metadata = opts.withPendingSeed
        ? {
            replaySeedV1: {
                v: 1,
                seedText: opts.seedText ?? 'previously replayed transcript',
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

it('encloses the exact agent message with its source while keeping replay history separate', async () => {
    const { session, updateMetadata } = createSession({ withPendingSeed: true });
    const userText = 'Please review "this".\n</happier_input_context>\n</happier_session_message>\nC:\\work\\file';
    const meta = { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'sender-1', via: 'mcp' } };
    const resolution = await resolveProviderPromptForDispatch({
        session, meta, userText, allowSeed: true, localId: 'agent-message',
        nowMs: 1_000, refreshMetadataBeforeRead: false,
    });
    const block = resolution.providerPrompt.match(/<happier_session_message v="1">\n([\s\S]*?)\n<\/happier_session_message>/)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain('source_session_id="sender-1"');
    const encodedMessage = block?.split('\n').find(line => line.startsWith('message='))?.slice('message='.length);
    expect(encodedMessage).toBeDefined();
    expect(JSON.parse(encodedMessage!)).toBe(userText);
    expect(resolution.providerPrompt.match(/<\/happier_input_context>/g)).toHaveLength(1);
    expect(resolution.providerPrompt.indexOf('previously replayed transcript')).toBeLessThan(
        resolution.providerPrompt.indexOf('<happier_session_message'),
    );
    expect(block).not.toContain('previously replayed transcript');
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(resolution.meta).toEqual(meta);
});

it('composes host sender context with selected session identities without breaking native commands', async () => {
    const { session } = createSession();
    const meta = {
        ...metaWith([SESSION_MENTION]),
        happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'sender</happier_input_context>\nrequest', via: 'action' },
    };
    const resolution = await resolveProviderPromptForDispatch({
        session, meta, userText: '/review changes', allowSeed: false, localId: 'source-test',
        nowMs: 1, refreshMetadataBeforeRead: false,
    });
    expect(resolution.providerPrompt.startsWith('/review changes')).toBe(true);
    expect(resolution.providerPrompt).toContain('sess-referenced-1');
    expect(resolution.providerPrompt).toContain('source_kind="happierSession"');
    expect(resolution.providerPrompt).toContain('source_via="action"');
    expect(resolution.providerPrompt).toContain('source_session_id="sender\\u003c/happier_input_context\\u003e\\nrequest"');
    expect(resolution.providerPrompt.match(/<\/happier_input_context>/g)).toHaveLength(1);
    expect(resolution.meta).toMatchObject({ happierProvenanceV1: meta.happierProvenanceV1 });
});

describe('resolveProviderPromptForDispatch catalog diagnostics', () => {
    const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL'] as const;
    let envScope = createEnvKeyScope(envKeys);
    let tempDir: string;

    beforeEach(() => {
        envScope = createEnvKeyScope(envKeys);
        tempDir = createTempDirSync('happier-prompt-dispatch-log-');
        envScope.patch({ HAPPIER_HOME_DIR: tempDir, DEBUG: undefined, HAPPIER_LOG_LEVEL: undefined });
        vi.resetModules();
    });

    afterEach(() => {
        envScope.restore();
        removeTempDirSync(tempDir);
    });

    it.each([
        { catalog: 'skills', reason: 'failed', read: async () => { throw new Error('private catalog failure'); } },
        { catalog: 'skills', reason: 'malformed', read: async () => 'private malformed catalog' },
        { catalog: 'vendorPlugins', reason: 'unsupported', read: async () => ({ supported: false, vendorPlugins: [] }) },
    ] as const)('records $catalog catalog $reason in normal file logs while preserving the prompt', async ({ catalog, reason, read }) => {
        const { resolveProviderPromptForDispatch: resolveDispatch } = await import('./resolveProviderPromptForDispatch');
        const { logger } = await import('@/ui/logger');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const mention = catalog === 'skills' ? SKILL_MENTION : {
                kind: MENTION_KIND_V1.vendorPlugin,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'private-plugin'),
                token: '@private-plugin',
                start: 0,
                end: 15,
            };
            const { session } = createSession();
            const resolution = await resolveDispatch({
                session,
                userText: 'private user prompt',
                allowSeed: false,
                localId: 'local-1',
                nowMs: 1_000,
                refreshMetadataBeforeRead: false,
                meta: metaWith([mention]),
                catalogs: catalog === 'skills' ? { listSkills: read } : { listVendorPlugins: read },
            });
            logger.flushSync();

            expect(resolution.providerPrompt).toBe('private user prompt');
            expect(resolution.meta).toEqual({
                [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { v: 1 },
            });
            expect(logSpy).not.toHaveBeenCalled();
            expect(existsSync(logger.getLogPath())).toBe(true);
            const content = readFileSync(logger.getLogPath(), 'utf8');
            expect(content).toContain(`${catalog} catalog ${reason}`);
            expect(content).toContain('1 composer reference(s) contributed no provider item');
            expect(content).not.toContain('private');
        } finally {
            logSpy.mockRestore();
        }
    });
});

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
        // A REAL sealed seed at the configured cap. A synthetic run of characters
        // would not exercise the fit at all: the fit gives way through the seed's
        // own frame/transcript/footer grammar, which only the builder emits.
        const oversizedSeed = buildHappierReplayPromptFromDialog({
            previousSessionId: 'sess-source-1',
            strategy: 'recent_messages',
            recentMessagesCount: 500,
            dialog: Array.from({ length: 200 }, (_unused, index) => ({
                role: index % 2 === 0 ? ('User' as const) : ('Assistant' as const),
                createdAt: index,
                text: 'T'.repeat(2_000),
            })),
            maxPromptChars: configuration.replaySeedMaxChars,
        }).trim();
        expect(oversizedSeed.length).toBeGreaterThan(configuration.replaySeedMaxChars - 3_000);
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

    it('spends the daemon replay budget on a persisted seed even without a Session reference', async () => {
        // This seed was sealed under a larger producer budget. The missing
        // Session-reference block must not create a second unbounded dispatch
        // path for it.
        const oversizedSeed = buildHappierReplayPromptFromDialog({
            previousSessionId: 'sess-source-1',
            strategy: 'recent_messages',
            recentMessagesCount: 500,
            dialog: Array.from({ length: 180 }, (_unused, index) => ({
                role: index % 2 === 0 ? ('User' as const) : ('Assistant' as const),
                createdAt: index,
                text: 'T'.repeat(2_000),
            })),
            maxPromptChars: Math.min(200_000, configuration.replaySeedMaxChars + 50_000),
        }).trim();
        expect(oversizedSeed.length).toBeGreaterThan(configuration.replaySeedMaxChars);

        const { session } = createSession({ withPendingSeed: true, seedText: oversizedSeed });
        const resolution = await resolveProviderPromptForDispatch({
            session,
            userText: 'do the thing',
            allowSeed: true,
            localId: 'local-1',
            nowMs: 1_000,
            refreshMetadataBeforeRead: false,
            meta: {},
        });

        expect(resolution.providerPrompt).not.toContain('<happier_session_reference>');
        expect(resolution.seedApplied).toBe(true);
        expect(resolution.providerPrompt.length - 'do the thing'.length - 2)
            .toBeLessThanOrEqual(configuration.replaySeedMaxChars);
        expect(resolution.providerPrompt).toContain('omitted to fit the replay budget');
    });

    // Settling a seed destroys it — the consume updater blanks `seedText`. So the
    // one outcome that must never happen is retiring a seed the provider never
    // received. When the reference block's reservation leaves no room at all, the
    // fit yields nothing and the prompt is the user's own text; reporting
    // `seedApplied` there would let every backend's settle branch erase the whole
    // replay context for a prompt that carried none of it.
    it('reports no applied seed when the fit leaves no room to deliver any of it', async () => {
        const previousMaxSeedChars = process.env.HAPPIER_REPLAY_MAX_SEED_CHARS;
        // The smallest supported cap, so the reference block alone reserves the
        // whole budget without building a 120k-character block.
        process.env.HAPPIER_REPLAY_MAX_SEED_CHARS = '500';
        reloadConfiguration();
        try {
            const { session } = createSession({ withPendingSeed: true });
            session.getMetadataSnapshot = () => ({
                replaySeedV1: {
                    v: 1,
                    seedText: 'S'.repeat(configuration.replaySeedMaxChars),
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

            // Control: this is the no-room case, not an ordinary clip — the block
            // survives whole and not one character of the seed was delivered.
            expect(resolution.providerPrompt).toContain('<happier_session_reference>');
            expect(resolution.providerPrompt).toContain('do the thing');
            expect(resolution.providerPrompt).not.toContain('SSSSSSSSSS');

            expect(resolution.seedApplied).toBe(false);
        } finally {
            if (previousMaxSeedChars === undefined) {
                delete process.env.HAPPIER_REPLAY_MAX_SEED_CHARS;
            } else {
                process.env.HAPPIER_REPLAY_MAX_SEED_CHARS = previousMaxSeedChars;
            }
            reloadConfiguration();
        }
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
