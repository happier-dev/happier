import { existsSync } from 'node:fs';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentDetail } from '../pages/AgentDetail';

import {
    AGENTS,
    AGENT_META,
    UNLISTED_AGENTS,
    UPCOMING_AGENTS,
    setupLinkFor,
    type AgentRecord,
    type InstallKind,
} from './agents';
import { SHIPPED_AGENT_IDS, SHIPPED_TREE_ENV_VAR, isShippedAgentId } from './availability';
import {
    readShippedAgentIds,
    readShippedCliFacts,
    readShippedManifestFacts,
    resolveShippedTreeRoot,
} from './shippedTree';

/**
 * THE ROT GATE FOR /agents AND EVERY /agents/<slug> PAGE.
 *
 * happier.dev's rule for minting a URL is that a build-time test must be able to
 * FAIL when the page drifts. This is that test.
 *
 * THE BUG IN THE PREVIOUS VERSION OF THIS FILE
 * --------------------------------------------
 * It imported `../../../../packages/agents/src/generated/agentIds` — a path that
 * resolves INSIDE this repository, which is the UNRELEASED tree. So the guard
 * that existed to stop the site claiming things the product cannot do was
 * reading the registry that is ahead of the product. Four agents that ship in no
 * release (antigravity, ohMyPi, coderabbit, deepsec) passed it and were
 * published as though they ran.
 *
 * Everything here now measures against the RELEASED tree: SHIPPED_AGENT_IDS in
 * ./availability.ts for the set, and the released manifest and CLI runtime spec,
 * read through ./shippedTree.ts, for the per-agent facts. The unreleased
 * registry is still read — but only to work out what is UPCOMING, and an
 * upcoming agent may not appear anywhere a shipped one does.
 *
 * WHAT IS ASSERTED, AND AGAINST WHAT
 *   released registry   the id set, the binary, the subcommand, the vendor
 *                       URLs, the install path, local control, connected
 *                       services, tool delivery
 *   unreleased registry the UPCOMING set, and nothing else
 *   the docs repo       happierDocsPath resolves to a real .mdx
 *   shape only          h1, standfirst, lead, whatItDoes, faq
 */

const DOCS_CONTENT_DIR = path.resolve(__dirname, '../../../docs/content/docs');

/** Registry → the single install fact the page publishes. */
function expectedInstall(id: string): { kind: InstallKind; source: string | null } | null {
    const facts = readShippedCliFacts(id);
    if (!facts) return null;
    if (facts.managedKind === 'managed_package') {
        return { kind: 'happier-managed-package', source: facts.managedSource };
    }
    if (facts.managedKind === 'github_release_binary') {
        return { kind: 'happier-managed-release', source: facts.managedSource };
    }
    if (facts.manualInstallKind === 'vendor_recipe') return { kind: 'vendor-script', source: null };
    return { kind: 'you-install-it', source: null };
}

describe('the site measures itself against the RELEASED registry', () => {
    /**
     * The guard's own guard. A cross-tree check that cannot find the other tree
     * is a check that did not happen, and the previous version of this file is
     * the argument for not letting that pass quietly.
     */
    it('can see the released tree', () => {
        expect(
            resolveShippedTreeRoot(),
            `The released checkout was not found beside this one. Every assertion below ` +
                `compares this site against the build people can install; without it they are ` +
                `comparing the site against itself, which is the defect this file exists for. ` +
                `Point ${SHIPPED_TREE_ENV_VAR} at the release checkout.`,
        ).not.toBeNull();
    });

    it('transcribes AGENT_IDS from the released tree without drift', () => {
        const shipped = readShippedAgentIds();
        if (!shipped) return; // reported by the test above
        expect(
            [...SHIPPED_AGENT_IDS],
            'SHIPPED_AGENT_IDS in src/data/availability.ts no longer matches the released ' +
                'packages/agents/src/types.ts. Update the transcription — and then check ' +
                'whether the new id needs a page, an UNLISTED_AGENTS reason, or nothing.',
        ).toEqual(shipped);
    });

    it('accounts for every id the release actually ships', () => {
        const covered = new Set([...AGENTS.map((a) => a.id), ...Object.keys(UNLISTED_AGENTS)]);
        const unaccounted = SHIPPED_AGENT_IDS.filter((id) => !covered.has(id));

        expect(
            unaccounted,
            'A shipped agent has no page and no written reason for not having one. Give it ' +
                'an entry in AGENTS or in UNLISTED_AGENTS. Leaving it out silently is how ' +
                '/agents becomes a list that claims we support fewer agents than we do — ' +
                'which is exactly what happened to customAcp.',
        ).toEqual([]);
    });

    it('never presents an agent the release does not ship', () => {
        for (const agent of AGENTS) {
            expect(
                isShippedAgentId(agent.id),
                `/agents/${agent.slug} names '${agent.id}', which is not in the released ` +
                    `AGENT_IDS. If it exists only in this repository it belongs in ` +
                    `UPCOMING_AGENTS, behind the not-yet-available label.`,
            ).toBe(true);
            expect(agent.availability).toBe('shipped');
        }
        for (const id of Object.keys(UNLISTED_AGENTS)) {
            expect(isShippedAgentId(id), `UNLISTED_AGENTS names '${id}', which is not shipped`).toBe(
                true,
            );
        }
    });

    it('keeps the upcoming set disjoint from the shipped one', () => {
        for (const agent of UPCOMING_AGENTS) {
            expect(
                isShippedAgentId(agent.id),
                `UPCOMING_AGENTS names '${agent.id}', which IS in the released build. An agent ` +
                    `that ships must not be described as upcoming — give it a page instead.`,
            ).toBe(false);
            expect(agent.availability).toBe('upcoming');
        }
    });
});

describe('the per-agent facts come from the released manifest', () => {
    it('names the binary and the subcommand the release actually uses', () => {
        for (const agent of AGENTS) {
            const cli = readShippedCliFacts(agent.id);
            const manifest = readShippedManifestFacts(agent.id);
            if (!cli || !manifest) return;
            expect(agent.binary, `/agents/${agent.slug} binary`).toBe(cli.binaryName);
            // The page tells people to type `happier <id>`; that has to be the
            // subcommand the shipped CLI dispatches on.
            expect(agent.id, `/agents/${agent.slug} cli subcommand`).toBe(manifest.cliSubcommand);
        }
    });

    /**
     * Vendor URLs, asserted one way on purpose.
     *
     * `vendorDocs` must be the released `docsUrl` exactly — it is not a field
     * anyone should be authoring. `vendorSetupGuide` must match the released
     * `guideUrl` WHERE ONE EXISTS; where the release carries none, the site is
     * allowed to carry a setup page someone found, because "the vendor publishes
     * no guide URL in our registry" is not the same claim as "the vendor has no
     * setup page". What it may never do is contradict a guide the registry has.
     */
    it('carries the vendor URLs the released registry declares', () => {
        for (const agent of AGENTS) {
            const cli = readShippedCliFacts(agent.id);
            if (!cli) return;
            expect(agent.vendorDocs, `/agents/${agent.slug} vendorDocs`).toBe(cli.docsUrl);
            if (cli.installGuideUrl) {
                expect(agent.vendorSetupGuide, `/agents/${agent.slug} vendorSetupGuide`).toBe(
                    cli.installGuideUrl,
                );
            }
        }
    });

    /**
     * The bug this test exists for: the page rendered `docsUrl`, which for
     * Claude Code is https://claude.ai, for Grok https://x.ai and for Auggie
     * https://augmentcode.com — three product homepages sent to someone looking
     * for install instructions, while `guideUrl` sat unused one field away.
     */
    it('prefers the setup guide over the product homepage', () => {
        for (const agent of AGENTS) {
            const link = setupLinkFor(agent);
            if (agent.vendorSetupGuide) {
                expect(link, `/agents/${agent.slug} must link the setup guide, not the homepage`).toBe(
                    agent.vendorSetupGuide,
                );
            } else {
                expect(link, `/agents/${agent.slug} falls back to vendorDocs`).toBe(agent.vendorDocs);
            }
        }
    });

    /**
     * The previous test proves the PREFERENCE. This one proves the RESULT, which
     * is the part that was still wrong: kiro and auggie both had
     * `vendorSetupGuide: null`, so "prefers the guide over the homepage" passed
     * while the pages linked augmentcode.com (a marketing homepage) and an ACP
     * protocol reference (the right page for how Happier talks to Kiro, the
     * wrong one for installing it). A homepage has no path; a setup page does,
     * and that is a check a null field cannot pass by staying null.
     */
    it('sends every agent page at a vendor URL with a setup page behind it', () => {
        for (const agent of AGENTS) {
            const link = setupLinkFor(agent);
            expect(
                link,
                `/agents/${agent.slug} carries neither a setup guide nor vendor docs, so the ` +
                    `page has nowhere to send someone who has to install it`,
            ).not.toBeNull();
            const pathname = new URL(link!).pathname.replace(/\/$/, '');
            expect(
                pathname,
                `/agents/${agent.slug} links ${link} — a bare product homepage, which is not ` +
                    `install instructions. Find the vendor's setup page and put it in ` +
                    `vendorSetupGuide.`,
            ).not.toBe('');
        }
    });

    /**
     * Kiro is the only agent with installKind 'you-install-it': Happier ships no
     * managed package, no release binary and no vendor recipe for it, so the
     * vendor link IS the install instruction rather than a footnote to one.
     */
    it('gives every agent Happier cannot install a real setup guide', () => {
        for (const agent of AGENTS) {
            if (agent.installKind !== 'you-install-it') continue;
            expect(
                agent.vendorSetupGuide,
                `/agents/${agent.slug} is the reader's own install job and the page offers no ` +
                    `setup guide, so its only instruction is whatever vendorDocs happens to be`,
            ).not.toBeNull();
        }
    });

    it('describes the install path the release declares', () => {
        for (const agent of AGENTS) {
            const expected = expectedInstall(agent.id);
            if (!expected) return;
            expect(agent.installKind, `/agents/${agent.slug} installKind`).toBe(expected.kind);
            expect(agent.managedSource, `/agents/${agent.slug} managedSource`).toBe(expected.source);
        }
    });

    /**
     * LOCAL CONTROL — the fact the pages were most wrong about.
     *
     * Every page used to promise the vendor's own TUI. The released manifest
     * declares a usable attach strategy for three agents. Three more declare
     * `localControl.supported` with `attachStrategy: 'unsupported'`, which is
     * not a hand-off anyone can perform, and the site collapses those to 'none'
     * — this asserts that collapse rather than trusting it.
     */
    it('claims a terminal hand-off only where the release declares a usable one', () => {
        for (const agent of AGENTS) {
            const manifest = readShippedManifestFacts(agent.id);
            if (!manifest) return;
            const strategy = manifest.localControl?.supported
                ? manifest.localControl.attachStrategy
                : null;
            const expected =
                strategy === 'tmux'
                    ? 'tmux'
                    : strategy === 'provider_attach'
                      ? 'provider-attach'
                      : 'none';
            expect(
                agent.runtime.localControl.kind,
                `/agents/${agent.slug} claims local control '${agent.runtime.localControl.kind}' ` +
                    `while the release declares attachStrategy '${strategy ?? 'none'}'`,
            ).toBe(expected);
            if (agent.runtime.localControl.kind !== 'none') {
                expect(agent.runtime.localControl.topology).toBe(manifest.localControl?.topology);
            }
        }
    });

    it('names exactly the three agents whose sessions can reach a vendor TUI', () => {
        const withHandoff = AGENTS.filter((a) => a.runtime.localControl.kind !== 'none').map(
            (a) => a.id,
        );
        expect(withHandoff.sort()).toEqual(['claude', 'codex', 'opencode']);
    });

    it('lists the connected services the release says the agent can consume', () => {
        for (const agent of AGENTS) {
            const manifest = readShippedManifestFacts(agent.id);
            if (!manifest) return;
            expect(
                [...agent.runtime.connectedServices],
                `/agents/${agent.slug} connected services`,
            ).toEqual(manifest.connectedServiceIds);
        }
    });

    it('states the tool delivery the release declares', () => {
        for (const agent of AGENTS) {
            const manifest = readShippedManifestFacts(agent.id);
            if (!manifest) return;
            const expected = manifest.toolsDelivery === 'native_mcp' ? 'native-mcp' : 'shell-bridge';
            expect(agent.runtime.toolsDelivery, `/agents/${agent.slug} tool delivery`).toBe(expected);
        }
    });

    /**
     * TERMINAL PROMPT INJECTION — the fact the Claude Unified copy stands on.
     *
     * `runtimeInput.terminalPromptInjectionSupported` in the released manifest
     * is true for claude and for nothing else; pi declares it false beside
     * `inFlightSteerSupported: true`, which is the pair pi's lead names. If a
     * release moves either, the page describing a correction typed into the
     * vendor's own terminal has to move with it.
     */
    it('claims terminal prompt injection only where the release declares it', () => {
        for (const agent of AGENTS) {
            const manifest = readShippedManifestFacts(agent.id);
            if (!manifest) return;
            expect(
                agent.runtime.terminalPromptInjection,
                `/agents/${agent.slug} says terminalPromptInjection ` +
                    `${agent.runtime.terminalPromptInjection} while the release declares ` +
                    `${manifest.terminalPromptInjection}`,
            ).toBe(manifest.terminalPromptInjection);
        }
    });

    it('only links a Happier docs page that exists in this repository', () => {
        for (const agent of AGENTS) {
            if (!agent.happierDocsPath) continue;
            const file = path.join(DOCS_CONTENT_DIR, `${agent.happierDocsPath.replace(/^\//, '')}.mdx`);
            expect(
                existsSync(file),
                `/agents/${agent.slug} links ${agent.happierDocsPath}, but ${file} does not exist`,
            ).toBe(true);
        }
    });
});

/** Every authored sentence on a page, flattened. */
function prose(agent: AgentRecord): string[] {
    return [
        agent.h1,
        agent.standfirst,
        ...agent.lead,
        ...agent.whatItDoes,
        ...agent.faq.flatMap((item) => [item.q, item.a]),
    ];
}

describe('the pages make no claim they cannot keep', () => {
    /**
     * Superlatives and cross-agent rankings.
     *
     * Every false claim the copy audit found on these pages was one of these:
     * "the only agent that…", "the strongest …of any agent", "better than
     * Claude Code". They were all downstream of the pages trying to be a
     * capability reference. The reference is gone; this keeps the vocabulary
     * from creeping back with it.
     */
    const SUPERLATIVE =
        /\b(the only agent|only agent in|the only one|no other agent|nothing else in|unlike (?:claude|codex|opencode|cursor|gemini|copilot|qwen|kimi|kilo|kiro|auggie|pi|grok|every|any)|better than|beats\b|outperforms|the best\b|the fastest\b|the most capable|unmatched|world-class|industry-leading)/i;

    it('uses no superlative and ranks no vendor against another', () => {
        const offenders: string[] = [];
        for (const agent of AGENTS) {
            for (const line of prose(agent)) {
                const hit = line.match(SUPERLATIVE);
                if (hit) offenders.push(`/agents/${agent.slug}: "${hit[0]}" in "${line.slice(0, 70)}…"`);
            }
        }
        expect(
            offenders,
            'An agent page is ranking vendors again. A superlative we cannot prove is a ' +
                'liability: someone who knows what these agents do will read it, know it is ' +
                'wrong, and leave. State what Happier does with this agent instead.',
        ).toEqual([]);
    });

    /**
     * The copy gate on the unified terminal.
     *
     * It is the one differentiator on these pages about driving the VENDOR's
     * own interface rather than Happier's, which makes it the sentence most
     * likely to be pasted onto a page it is not true of. A page may only use
     * that vocabulary if its own record — asserted against the released
     * manifest above — declares terminal prompt injection.
     */
    it('lets only a terminal-injecting agent describe a unified terminal', () => {
        const UNIFIED = /unified terminal|typed into (?:claude code|the vendor|its own)|joins the work in progress/i;
        const offenders: string[] = [];
        for (const agent of AGENTS) {
            if (agent.runtime.terminalPromptInjection) continue;
            for (const line of prose(agent)) {
                const hit = line.match(UNIFIED);
                if (hit) offenders.push(`/agents/${agent.slug}: "${hit[0]}" in "${line.slice(0, 70)}…"`);
            }
        }
        expect(
            offenders,
            'A page describes the unified terminal runtime for an agent whose record does ' +
                'not declare terminal prompt injection. The released manifest declares it for ' +
                'Claude Code only; copying the sentence sideways is how one real ' +
                'differentiator becomes thirteen false ones.',
        ).toEqual([]);
    });

    it('shares no authored sentence between two agents', () => {
        // Short shared phrases are genuinely the same fact stated about
        // different agents. Anything substantial that repeats is a template.
        const SUBSTANTIAL = 90;
        const seen = new Map<string, string>();
        const duplicates: string[] = [];

        for (const agent of AGENTS) {
            for (const line of prose(agent)) {
                if (line.length < SUBSTANTIAL) continue;
                const previous = seen.get(line);
                if (previous) duplicates.push(`${previous} and ${agent.slug}: "${line.slice(0, 70)}…"`);
                else seen.set(line, agent.slug);
            }
        }

        expect(
            duplicates,
            'Two agent pages share a substantial sentence. That is the doorway-page ' +
                'pattern: swap the brand, keep the copy. Rewrite one of them with a fact ' +
                'that is only true of that agent.',
        ).toEqual([]);
    });

    it('varies the H1 instead of shipping thirteen of one template', () => {
        const h1s = AGENTS.map((a) => a.h1);
        expect(new Set(h1s).size, 'two agents share an H1').toBe(h1s.length);

        // "Open-source app for X" is the shape the reference page uses and it is
        // the right one for the agents people search for by name. Thirteen of
        // them is a template. A minority of them is a house style.
        const templated = h1s.filter((h1) => /^Open-source app for /i.test(h1));
        expect(
            templated.length,
            `${templated.length} of ${h1s.length} H1s use the "Open-source app for X" shape. ` +
                'Vary the rest by intent instead: "X from your phone", "Run X from …".',
        ).toBeLessThanOrEqual(5);
    });

    it('asks four to six real questions on every page', () => {
        for (const agent of AGENTS) {
            expect(agent.faq.length, `/agents/${agent.slug} FAQ length`).toBeGreaterThanOrEqual(4);
            expect(agent.faq.length, `/agents/${agent.slug} FAQ length`).toBeLessThanOrEqual(6);
            for (const item of agent.faq) {
                expect(item.q.trim().endsWith('?'), `/agents/${agent.slug}: "${item.q}" is not a question`).toBe(
                    true,
                );
                expect(item.a.trim().length, `/agents/${agent.slug}: "${item.q}" has a stub answer`).toBeGreaterThan(
                    80,
                );
            }
        }

        const questions = AGENTS.flatMap((a) => a.faq.map((item) => item.q));
        expect(new Set(questions).size, 'two agent pages ask the same question verbatim').toBe(questions.length);
    });

    it('gives every page enough body text to be worth indexing', () => {
        for (const agent of AGENTS) {
            const words = prose(agent).join(' ').split(/\s+/).length;
            expect(words, `/agents/${agent.slug} has only ${words} words of copy`).toBeGreaterThan(300);
        }
    });

    it('keeps slugs unique, url-safe and distinct from the raw ids where the id is not a word', () => {
        const slugs = AGENTS.map((a) => a.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
        for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it('gives every page its own title and description', () => {
        for (const agent of AGENTS) {
            expect(AGENT_META[agent.slug], `AGENT_META has no entry for '${agent.slug}'`).toBeDefined();
        }
        expect(Object.keys(AGENT_META).length).toBe(AGENTS.length);
    });

    it('writes a reason for every shipped agent it deliberately leaves out', () => {
        for (const [id, reason] of Object.entries(UNLISTED_AGENTS)) {
            expect(reason.length, `UNLISTED_AGENTS['${id}'] needs a real reason`).toBeGreaterThan(80);
        }
    });
});

/**
 * THE DIFFERENTIATION GATE.
 *
 * The complaint that produced this block was that the thirteen pages were "the
 * same page with different facts filled in". The wrong fix is to reword them —
 * thirteen rewordings of one argument is a doorway set, and a search engine
 * reads the rewriting as the tell. The right fix is that each page LEADS with
 * something that is true of one agent and false of the other twelve, which is
 * what `lead` is for.
 *
 * These assert that the leads stay substantial and stay distinct, and put a
 * ceiling on how alike the authored copy may become. The ceiling is measured on
 * 5-word shingles, which is roughly what a near-duplicate detector looks at.
 */
describe('every agent page leads with something only that agent can say', () => {
    // `\p{L}\p{N}`, not `a-z0-9`. The ASCII-only class returned THREE tokens for
    // a Russian, Japanese or Chinese paragraph — only the Latin product names
    // survived — which would make every similarity gate below pass vacuously the
    // day an agent page is translated. A guard that cannot fail is worse than no
    // guard, because it reports green.
    const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

    function words(text: string): string[] {
        const raw = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’./@-]*/gu) ?? [];
        // CJK has no spaces, so a whole run matches as a single token. Split it
        // per character so a shingle spans real content rather than one blob.
        return raw.flatMap((token) => (CJK_RUN.test(token) ? Array.from(token) : [token]));
    }

    function shingles(text: string, n = 5): Set<string> {
        const ws = words(text);
        const out = new Set<string>();
        for (let i = 0; i + n <= ws.length; i += 1) out.add(ws.slice(i, i + n).join(' '));
        return out;
    }

    /**
     * THE FLOOR IS THE POINT, AND IT IS WHY THE PAGE SET IS STILL THIRTEEN.
     *
     * The old bounds were 55-120 words in one paragraph, which is what made the
     * pages thin: one paragraph of difference, then five sections of shared
     * product argument. The rule now is that a page earns its URL by carrying
     * 200 words that are true of that agent and of no other — the launch
     * command, the permission mapping, the sign-in flow, the vendor's own
     * positioning. An agent that cannot reach the floor without repeating the
     * page next door is not a page: it is a card on /agents, and this test is
     * where that decision gets forced rather than deferred.
     *
     * The ceiling is a ceiling on ONE section, not on the page. Past ~350 words
     * the lead stops being the thing that tells you whether to keep reading.
     */
    it('gives every page a lead that earns the page', () => {
        for (const agent of AGENTS) {
            const count = words(agent.lead.join(' ')).length;
            expect(
                count,
                `/agents/${agent.slug} leads with ${count} words. Under 200 and the page is a ` +
                    'card in a grid wearing a URL — either find what is true of this agent and ' +
                    'nothing else, or collapse it into a row on /agents.',
            ).toBeGreaterThanOrEqual(200);
            expect(count, `/agents/${agent.slug} lead is ${count} words`).toBeLessThanOrEqual(360);
        }

        // Paragraphs, because 300 words in one <p> is a wall and the section is
        // the first thing anyone reads.
        for (const agent of AGENTS) {
            expect(agent.lead.length, `/agents/${agent.slug} lead paragraphs`).toBeGreaterThanOrEqual(2);
            expect(agent.lead.length, `/agents/${agent.slug} lead paragraphs`).toBeLessThanOrEqual(4);
        }
    });

    /**
     * A ratio, not a ban on repeated words.
     *
     * Zero shared five-word runs is the wrong bar: "a Codex subscription, an
     * OpenAI key, a Claude subscription or an Anthropic key" is one FACT, and
     * two agents that both accept those four credentials are entitled to say so
     * in the same words. What is not entitled to repeat is the sentence AROUND
     * the fact. 6% of five-word runs is roughly one shared proper-noun list;
     * anything higher is a lead written from the neighbouring lead.
     */
    it('keeps any two leads from being written from each other', () => {
        const worst: Array<{ pair: string; overlap: number }> = [];
        for (let i = 0; i < AGENTS.length; i += 1) {
            for (let j = i + 1; j < AGENTS.length; j += 1) {
                const a = shingles(AGENTS[i].lead.join(' '));
                const b = shingles(AGENTS[j].lead.join(' '));
                let shared = 0;
                for (const shingle of a) if (b.has(shingle)) shared += 1;
                const union = a.size + b.size - shared;
                worst.push({
                    pair: `${AGENTS[i].slug}/${AGENTS[j].slug}`,
                    overlap: union === 0 ? 0 : shared / union,
                });
            }
        }
        const top = worst.reduce((x, y) => (x.overlap > y.overlap ? x : y));
        expect(
            top.overlap,
            `${top.pair} share ${(top.overlap * 100).toFixed(1)}% of their five-word runs. The ` +
                'lead is the one part of the page written from scratch for that agent; this much ' +
                'overlap means it was written from the template, or from the lead next to it.',
        ).toBeLessThan(0.06);
    });

    /**
     * THE TEST THAT FORCES THE KEEP-OR-COLLAPSE DECISION ON THE NEXT AGENT.
     *
     * A pairwise ceiling catches two pages that read alike. It does not catch
     * the thing that actually produces a doorway set: a fourteenth page added
     * because a fourteenth agent shipped, carrying nothing but the shared
     * argument with a different noun in it. That page would sit under every
     * pairwise limit here and still be worthless.
     *
     * So this measures each page against ALL the others at once: what share of
     * its five-word runs appear on no other agent page. Between 94% and 98%
     * when it was written. The floor is 85%, which a page written from the
     * template cannot reach and a page written from that agent's own launch,
     * permission mapping and sign-in flow clears without trying.
     *
     * Failing it is not a prompt to find synonyms. It is the signal that the
     * agent belongs in the grid on /agents rather than behind a URL of its own.
     */
    it('gives every page a body of copy that appears on no other agent page', () => {
        const sets = AGENTS.map((agent) => ({
            slug: agent.slug,
            shingles: shingles(prose(agent).join(' ')),
        }));

        for (const entry of sets) {
            let unique = 0;
            for (const shingle of entry.shingles) {
                const elsewhere = sets.some(
                    (other) => other.slug !== entry.slug && other.shingles.has(shingle),
                );
                if (!elsewhere) unique += 1;
            }
            const share = unique / entry.shingles.size;
            expect(
                share,
                `/agents/${entry.slug}: only ${(share * 100).toFixed(1)}% of its five-word runs ` +
                    'are unique to it. That page is mostly the argument every other agent page ' +
                    'makes. Give it what is true of this agent and nothing else — the command ' +
                    'Happier runs, how a permission mode reaches it, how it signs in — or make ' +
                    'it a card on /agents and redirect the URL.',
            ).toBeGreaterThan(0.85);
        }
    });

    function pairwiseJaccard(
        texts: ReadonlyArray<{ slug: string; text: string }>,
    ): { mean: number; worst: { pair: string; jaccard: number } } {
        const sets = texts.map((entry) => ({ slug: entry.slug, s: shingles(entry.text) }));
        const pairs: Array<{ pair: string; jaccard: number }> = [];
        for (let i = 0; i < sets.length; i += 1) {
            for (let j = i + 1; j < sets.length; j += 1) {
                const a = sets[i].s;
                const b = sets[j].s;
                let intersection = 0;
                for (const shingle of a) if (b.has(shingle)) intersection += 1;
                const union = a.size + b.size - intersection;
                pairs.push({
                    pair: `${sets[i].slug}/${sets[j].slug}`,
                    jaccard: union === 0 ? 0 : intersection / union,
                });
            }
        }
        return {
            mean: pairs.reduce((sum, p) => sum + p.jaccard, 0) / pairs.length,
            worst: pairs.reduce((a, b) => (a.jaccard > b.jaccard ? a : b)),
        };
    }

    /**
     * The ceiling on the AUTHORED copy.
     *
     * Measured at 0.2% mean / 1.9% max when this gate was written, because the
     * authored strings are now written per agent rather than filled into a
     * template. The limits sit well above that so an ordinary edit does not trip
     * them, and well below the level where two pages would read as one.
     */
    it('keeps the authored copy below the near-duplicate ceiling', () => {
        const { mean, worst } = pairwiseJaccard(
            AGENTS.map((agent) => ({ slug: agent.slug, text: prose(agent).join(' ') })),
        );
        expect(mean, `mean authored similarity is ${(mean * 100).toFixed(1)}%`).toBeLessThan(0.03);
        expect(
            worst.jaccard,
            `${worst.pair} are ${(worst.jaccard * 100).toFixed(1)}% alike on five-word runs`,
        ).toBeLessThan(0.06);
    });

    /**
     * The ceiling on the RENDERED pages, which is the number that actually
     * decides whether this is a doorway set.
     *
     * The authored copy being unique is not enough on its own: the surrounding
     * template is what a crawler sees, and thirteen renderings of one template
     * are thirteen near-identical documents no matter how good the paragraphs
     * inside it are.
     *
     * THE TWO MEASUREMENTS THIS NUMBER HAS BEEN THROUGH, AND WHAT THEY DECIDED
     * ------------------------------------------------------------------------
     * First pass — removing the nine-column capability matrix and writing the
     * authored strings per agent — took the whole component from 26.9% mean /
     * 34.0% max, with cursor/kimi at the top. The note left here then said the
     * remaining floor was honest, that six pages (auggie, kilo, qwen, copilot,
     * kimi, cursor) branch identically on every structural axis, and that if
     * the number had to come down further the answer was fewer pages.
     *
     * Second pass tested that. The obvious reading of "the descriptions are too
     * short" is to pad, and padding those six with reworded product argument is
     * exactly what would have proved the note right. So the extra 200 words a
     * page came from the launch instead — the command Happier runs, how a
     * permission mode is expressed to that agent, which sign-in flow the
     * provider page drives, what the vendor says the CLI is for — none of which
     * two agents share. The number went the other way:
     *
     *              mean      max
     *   before    26.36%   34.04%  (cursor/kimi)
     *   after     21.36%   26.81%  (qwen/auggie)
     *
     * Every pair among the six dropped 7-8 points. So the collapse the previous
     * note anticipated is not owed: all thirteen pages carry 230-356 words of
     * lead, and 94-98% of each page's five-word runs appear on no other agent
     * page. The ceilings below were tightened onto the new numbers, because a
     * ceiling left at the old level is a ceiling that permits the regression.
     *
     * IF THIS TEST FAILS, READ THE FIRST PARAGRAPH AGAIN. Rewording is the one
     * move that cannot fix it. Either the page has a fact the others do not, or
     * it is a card on /agents.
     */
    it('keeps the rendered pages below the doorway threshold', () => {
        const { mean, worst } = pairwiseJaccard(
            AGENTS.map((agent) => ({
                slug: agent.slug,
                text: renderToStaticMarkup(AgentDetail({ agent }))
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&[a-z]+;/g, ' '),
            })),
        );
        expect(mean, `mean rendered similarity is ${(mean * 100).toFixed(1)}%`).toBeLessThan(0.24);
        expect(
            worst.jaccard,
            `${worst.pair} render ${(worst.jaccard * 100).toFixed(1)}% alike. Give one of them a ` +
                'section the other does not have, or make it a row in the /agents table instead ' +
                'of a page — do not reword it, which adds risk rather than removing it.',
        ).toBeLessThan(0.3);
    });
});
