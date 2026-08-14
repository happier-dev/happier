import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AGENT_IDS as UNRELEASED_AGENT_IDS } from '../../../../packages/agents/src/generated/agentIds';
import { AGENTS, AGENT_META, UNLISTED_AGENTS, UPCOMING_AGENTS } from './agents';
import { SHIPPED_AGENT_IDS, UPCOMING_LABEL, UPCOMING_RELEASE, isShippedAgentId } from './availability';
import { GRID_FEATURES, PRIMARY_FEATURES } from './features';
import { ROUTES } from '../routes';
import { AgentsIndex } from '../pages/AgentsIndex';

/**
 * THE THREE-STATE GATE.
 *
 * SHIPPED may be described in the present tense. UPCOMING must be named as not
 * yet available and tied to the upcoming release. ABSENT does not appear.
 *
 * This is the file that would have caught the two defects that produced it:
 *
 *   1. Four agents that exist only in this repository (antigravity, ohMyPi,
 *      coderabbit, deepsec) were published on /agents as though they ran,
 *      because the guard that was supposed to stop that imported the
 *      unreleased registry — the very thing it needed to be measured against.
 *   2. The FAQ named two voice modes from a dev-only lab in this repository.
 *      The released build offers four different ones.
 *
 * Note the ONE import from the unreleased registry below. It is deliberate and
 * it is the only legitimate use of that path on this site: the unreleased set
 * MINUS the shipped set is exactly the definition of UPCOMING. It is never used
 * to decide what the site may claim.
 */

const unreleasedOnly = UNRELEASED_AGENT_IDS.filter((id) => !isShippedAgentId(id));

describe('the upcoming set is computed, not asserted', () => {
    it('derives upcoming from the unreleased registry minus the shipped one', () => {
        expect(
            UPCOMING_AGENTS.map((a) => a.id).sort(),
            'UPCOMING_AGENTS is out of step with the registries. Everything in the unreleased ' +
                'tree and not in the release belongs here, labelled; nothing else does.',
        ).toEqual([...unreleasedOnly].sort());
    });

    it('never lets an unreleased agent into a shipped-facing collection', () => {
        const shippedFacing = new Map<string, string>([
            ...AGENTS.map((a) => [a.id, `AGENTS (/agents/${a.slug})`] as const),
            ...Object.keys(UNLISTED_AGENTS).map((id) => [id, 'UNLISTED_AGENTS'] as const),
        ]);

        for (const id of unreleasedOnly) {
            expect(
                shippedFacing.get(id),
                `'${id}' is not in the released build but appears in ${shippedFacing.get(id)}. ` +
                    'That is the exact shape of the defect this file exists for.',
            ).toBeUndefined();
        }
    });

    it('mints no route and no page metadata for an unreleased agent', () => {
        for (const agent of UPCOMING_AGENTS) {
            for (const route of ROUTES) {
                expect(
                    route.path.includes(agent.id.toLowerCase()),
                    `${route.path} looks like a page for the unreleased '${agent.id}'`,
                ).toBe(false);
            }
            expect(Object.keys(AGENT_META)).not.toContain(agent.id);
        }
    });

    it('keeps every id in exactly one state', () => {
        for (const id of SHIPPED_AGENT_IDS) {
            expect(
                UPCOMING_AGENTS.some((a) => a.id === id),
                `'${id}' ships and is also listed as upcoming`,
            ).toBe(false);
        }
    });
});

describe('an upcoming agent is never described as though it ran', () => {
    const markup = renderToStaticMarkup(AgentsIndex());

    it('renders every upcoming agent behind the label', () => {
        for (const agent of UPCOMING_AGENTS) {
            expect(markup, `/agents does not name '${agent.name}' at all`).toContain(agent.name);
        }
        const labels = markup.split(UPCOMING_LABEL).length - 1;
        expect(
            labels,
            `/agents renders ${UPCOMING_AGENTS.length} upcoming agents but prints the ` +
                `"${UPCOMING_LABEL}" label ${labels} times. Every one of them needs it.`,
        ).toBe(UPCOMING_AGENTS.length);
    });

    it('names the release the reader would have to wait for', () => {
        expect(markup).toContain(UPCOMING_RELEASE);
    });

    /**
     * The label being present is not enough — it has to be attached to the
     * right thing. This checks the upcoming names appear only AFTER the point
     * where the shipped grid ends, so no amount of markup shuffling can move an
     * unreleased agent into the list of ones you can install.
     */
    it('keeps upcoming agents out of the shipped grid', () => {
        const gridEnd = markup.indexOf('data-section="agents-upcoming"');
        expect(gridEnd, 'the upcoming band is missing from /agents').toBeGreaterThan(-1);
        for (const agent of UPCOMING_AGENTS) {
            expect(
                markup.indexOf(agent.name),
                `'${agent.name}' appears above the upcoming band, where every other name on ` +
                    'the page is something you can install today',
            ).toBeGreaterThan(gridEnd);
        }
    });

    it('writes each note in the future tense, with a real reason', () => {
        for (const agent of UPCOMING_AGENTS) {
            expect(agent.note.length, `UPCOMING_AGENTS['${agent.id}'] needs a real note`).toBeGreaterThan(
                120,
            );
            expect(
                agent.note,
                `UPCOMING_AGENTS['${agent.id}'] claims Happier runs it. It does not — that is ` +
                    'what upcoming means.',
            ).not.toMatch(/\bHappier (runs|supports|ships|integrates with)\b/);
        }
    });
});

/**
 * THE SAME DISCIPLINE, APPLIED TO FEATURES.
 *
 * Agents were only half the leak. The voice modes in the FAQ came through the
 * feature copy, which had no notion of which release it was describing.
 */
describe('every feature declares which release it is in', () => {
    const all = [...PRIMARY_FEATURES, ...GRID_FEATURES];

    it('declares availability on every feature', () => {
        for (const feature of all) {
            expect(
                feature.availability,
                `feature '${feature.id}' has no availability. Decide: is it in the release, or ` +
                    'is it in this repository only?',
            ).toMatch(/^(shipped|upcoming)$/);
        }
    });

    /**
     * The home page has no upcoming band. Until it grows one — with the label —
     * a feature marked upcoming has nowhere honest to render, so this fails
     * rather than letting it render as though it shipped.
     */
    it('has nowhere to render an upcoming feature yet, and says so instead of pretending', () => {
        const upcoming = all.filter((feature) => feature.availability === 'upcoming');
        expect(
            upcoming.map((feature) => feature.id),
            'A feature is marked upcoming, but the sections that render features print no ' +
                `"${UPCOMING_LABEL}" label. Add the label to AlternatingFeatures/FeatureGrid ` +
                'before marking anything upcoming, or the reader is told it works today.',
        ).toEqual([]);
    });

    it('gives every feature a unique id, so availability cannot be attached to the wrong one', () => {
        const ids = all.map((feature) => feature.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
