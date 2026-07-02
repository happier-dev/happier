/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    evaluateMarkdownRichEligibility,
    preservesEmbeddedHtml,
    type EvaluateMarkdownRichEligibilityOptions,
} from '../../eligibility/markdownRichEligibility';

/**
 * F5 / Lane F: the web-only throwaway round-trip backing the eligibility gate.
 *
 * - It runs markdown through a real headless `@tiptap/core` editor and returns
 *   the re-serialized markdown (or `null` on failure).
 * - It caches by content hash so repeated calls for the same body are cheap.
 *
 * Constructing the editor touches the DOM (ProseMirror), so this runs in jsdom.
 * The failure path is exercised by mocking `@tiptap/core` to throw at
 * construction (the throwaway editor must never propagate; the gate treats a
 * `null` as "not preserved" -> raw fallback).
 */

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@tiptap/core');
});

describe('getRichMarkdownRoundTripOutput (success path)', () => {
    it('returns a re-serialized markdown string for clean markdown', async () => {
        const { getRichMarkdownRoundTripOutput } = await import('../markdownRoundTrip.web');
        const out = getRichMarkdownRoundTripOutput('# Title\n\nbody');
        expect(typeof out).toBe('string');
        expect(out).toContain('Title');
    });

    it('preserves embedded block HTML via the Phase-1.5 raw-HTML pre-pass -> gate admits', async () => {
        const { getRichMarkdownRoundTripOutput } = await import('../markdownRoundTrip.web');
        const body = 'Intro\n\n<div class="note">hello</div>';
        const out = getRichMarkdownRoundTripOutput(body);
        // The risky-markdown pre-pass (`encodeRiskyMarkdown`) rewrites the block
        // HTML to a sentinel, the raw-HTML atom node round-trips it verbatim, so the
        // fragment survives -> preservesEmbeddedHtml is true -> the gate stays
        // eligible (no whole-document raw fallback). This is the Phase-1.5 flip.
        expect(preservesEmbeddedHtml(body, out)).toBe(true);
    });

    it('preserves embedded inline HTML via the pre-pass', async () => {
        const { getRichMarkdownRoundTripOutput } = await import('../markdownRoundTrip.web');
        const body = 'before <span>x</span> after';
        const out = getRichMarkdownRoundTripOutput(body);
        expect(preservesEmbeddedHtml(body, out)).toBe(true);
    });

    it('returns the same cached value for the same body (cache hit)', async () => {
        const { getRichMarkdownRoundTripOutput } = await import('../markdownRoundTrip.web');
        const body = `# Cached doc ${Math.random()}\n\nsome body`;
        const first = getRichMarkdownRoundTripOutput(body);
        const second = getRichMarkdownRoundTripOutput(body);
        expect(second).toBe(first);
    });
});

describe('getRichMarkdownRoundTripOutput (failure path)', () => {
    it('returns null when the throwaway editor throws at construction', async () => {
        vi.resetModules();
        // Keep the rest of `@tiptap/core` real (StarterKit and friends import
        // `Extension` from it) and only replace `Editor` with a throwing stub.
        vi.doMock('@tiptap/core', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@tiptap/core')>();
            return {
                ...actual,
                Editor: class {
                    constructor() {
                        throw new Error('boom');
                    }
                },
            };
        });

        const { getRichMarkdownRoundTripOutput } = await import('../markdownRoundTrip.web');
        // Unique body so the module-level cache cannot mask the failure.
        const out = getRichMarkdownRoundTripOutput(`fails ${Math.random()}`);
        expect(out).toBeNull();
    });

    it('returns null when getMarkdown returns a non-string', async () => {
        vi.resetModules();
        vi.doMock('@tiptap/core', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@tiptap/core')>();
            return {
                ...actual,
                Editor: class {
                    getMarkdown() {
                        return undefined;
                    }
                    destroy() {
                        // no-op
                    }
                },
            };
        });

        const { getRichMarkdownRoundTripOutput } = await import('../markdownRoundTrip.web');
        const out = getRichMarkdownRoundTripOutput(`non-string ${Math.random()}`);
        expect(out).toBeNull();
    });
});

describe('eligibility gate with the REAL web round-trip adapter (Phase-1.5)', () => {
    const BASE_OPTS: EvaluateMarkdownRichEligibilityOptions = {
        language: 'markdown',
        maxBytes: 256_000,
        htmlRoundTripMaxBytes: 50_000,
    };

    it('admits an HTML document that round-trips losslessly through the real adapter', async () => {
        const { getRichMarkdownRoundTripOutput } = await import('../markdownRoundTrip.web');
        const raw = `# Doc ${Math.random()}\n\n<div class="note">hello</div>\n\nbody with <span>inline</span>.`;
        const result = evaluateMarkdownRichEligibility(raw, {
            ...BASE_OPTS,
            htmlRoundTrip: getRichMarkdownRoundTripOutput,
        });
        // The pre-pass + raw-HTML atoms preserve every fragment, so the gate is now
        // eligible where Phase-1 forced a raw fallback.
        expect(result).toEqual({ eligible: true });
    });

    it('still blocks HTML on native (no adapter injected)', () => {
        const raw = `# Doc ${Math.random()}\n\n<div>native blocks this</div>`;
        // No `htmlRoundTrip` -> conservative block, unchanged by Phase-1.5.
        expect(evaluateMarkdownRichEligibility(raw, BASE_OPTS)).toEqual({
            eligible: false,
            reason: 'html-or-jsx',
        });
    });
});
