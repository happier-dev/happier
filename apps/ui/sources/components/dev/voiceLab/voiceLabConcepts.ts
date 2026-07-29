import { AuroraConcept } from './concepts/AuroraConcept';
import { ComposerConcept } from './concepts/ComposerConcept';
import { RealComposerConcept } from './concepts/RealComposerConcept';
import { HorizonConcept } from './concepts/HorizonConcept';
import { OrbConcept } from './concepts/OrbConcept';
import { HaloConcept } from './concepts/HaloConcept';
import { SlateConcept } from './concepts/SlateConcept';
import { ThreadConcept } from './concepts/ThreadConcept';
import { TideConcept } from './concepts/TideConcept';
import type { VoiceConceptSpec } from './conceptTypes';

/**
 * The concept board.
 *
 * These five differ in **spatial and interaction model**, not in colour or
 * radius. One is an edge, one is a free object, one is a state of an existing
 * control, one is pure typography, one is a substance. If two of them could be
 * swapped by changing a stylesheet, one of them should not exist.
 */
export const VOICE_LAB_CONCEPTS: readonly VoiceConceptSpec[] = [
    {
        id: 'horizon',
        name: 'Horizon',
        thesis: 'A window onto the Happier planet, docked in the sidebar — with a transport you can actually operate.',
        model: 'Object in a bounded vessel. Tide’s container, Aurora’s rising limb, a filled Start/End pill and an unmistakable mic toggle.',
        strengths: [
            'The only concept with a real transport: start, end and mute are always where you expect them',
            'The bounded edge stops it competing with the app header the way a full-bleed band does',
            'Digit field + lit limb make it unmistakably the Happier planet, not a generic orb',
        ],
        risks: [
            'Gives up Aurora’s “no card at all” claim — this is a container again, deliberately',
            '132pt at rest is real sidebar budget taken from the session list',
        ],
        cost: 'medium',
        Component: HorizonConcept,
    },
    {
        id: 'orb',
        name: 'Orb',
        thesis: 'On mobile the planet itself becomes the floating companion.',
        model: 'App-level overlay. 58pt planet lit from the upper right, drag with projected throw and edge snap, unfurls into a sheet from its own body.',
        strengths: [
            'Phone has no sidebar at all, so Global Voice needs to be an object with a position',
            'Thumb-reachable and movable away from the keyboard',
            'The mute pip keeps the most important fact legible without relying on body colour',
        ],
        risks: [
            'Collides with the web pet companion — both want zIndex 90000, bottom-right',
            'A floating object must never cover the composer, dialogs, or safe areas',
        ],
        cost: 'high',
        Component: OrbConcept,
    },
    {
        id: 'real-composer',
        name: 'Real composer',
        thesis: 'The proposal mounted on the actual AgentInput — not a replica.',
        model: 'Voice contributed through the composer’s existing `extraActionChips` slot. Zero changes to AgentInput.',
        strengths: [
            'Additive: `extraActionChips.render(ctx)` is already a full node escape hatch',
            'Trailing slot resolves exactly as production does — dictation / send / stop — untouched',
            'You are judging the real chip row, radius, density and responsive behaviour',
        ],
        risks: [
            'The chip row is already dense; Voice competes for width at narrow sidebar sizes',
            'Chip-scale is small for a meter — legibility needs checking at real widths',
        ],
        cost: 'low',
        Component: RealComposerConcept,
    },
    {
        id: 'composer',
        name: 'Composer',
        thesis: 'In-session Voice is the composer’s leading control — the send slot is already full.',
        model: 'Leading edge of the existing composer. Planet + inline meter when live; send/dictate/stop keep the trailing slot untouched.',
        strengths: [
            'Voice stays reachable while the trailing slot is a Stop-turn button — they are different stops',
            'Dictation keeps the send slot it already owns; no collision with its separate owner',
            'Nothing moves when Voice starts: the composer keeps its exact geometry',
        ],
        risks: [
            'A leading control is less discoverable than the send slot everyone already looks at',
            'Adds a control to a composer row that is already dense on narrow widths',
        ],
        cost: 'low',
        Component: ComposerConcept,
    },
    {
        id: 'aurora',
        name: 'Aurora',
        thesis: 'Voice is a band of the sidebar, not a card inside it.',
        model: 'Container edge. Grows downward from 1pt rule → 98pt sky → 268pt conversation. Never appears or disappears.',
        strengths: [
            'Zero card chrome; costs 1pt when nothing is happening',
            'Reuses the onboarding horizon composition, so it is unmistakably Happier',
            'Compact → conversational is one continuous object, not two screens',
        ],
        risks: [
            'A luminous band on a light theme needs the grain to avoid reading as a rendering artefact',
            'Occupying the sidebar’s top edge competes with the app header for first attention',
        ],
        cost: 'medium',
        Component: AuroraConcept,
    },
    {
        id: 'halo',
        name: 'Halo',
        thesis: 'Global Voice is an object with a position in the app, not a region of a screen.',
        model: 'App-level overlay. 52pt sphere, drag with projected throw and edge snap; expands out of its own centre.',
        strengths: [
            'Genuinely persists across navigation — the only concept that models Global Voice honestly',
            'Best mobile ergonomics: thumb-reachable, movable away from the keyboard',
            'The sphere is the strongest identity object of the five',
        ],
        risks: [
            'Directly collides with the existing pet overlay: needs a stated coexistence policy',
            'A floating object must never cover the composer, dialogs, or safe areas',
            'Highest implementation cost (overlay layer, gesture, persistence, collision)',
        ],
        cost: 'high',
        Component: HaloConcept,
    },
    {
        id: 'thread',
        name: 'Thread',
        thesis: 'In-session Voice has no widget. The composer becomes the thing you speak into.',
        model: 'State of an existing control. Composer geometry never changes; the top edge lights and the placeholder resolves into live speech.',
        strengths: [
            'The only concept where in-session Voice is genuinely native to the conversation',
            'Nothing moves when Voice starts or ends — zero layout disturbance',
            'Cheapest to make accessible: it is already a labelled control',
        ],
        risks: [
            'Almost invisible as an entry point — discoverability needs solving elsewhere',
            'Does not answer Global Voice at all; needs a partner concept',
        ],
        cost: 'low',
        Component: ThreadConcept,
    },
    {
        id: 'slate',
        name: 'Slate',
        thesis: 'The transcript is the interface. State lives in type, not in light.',
        model: 'Typographic. Status set at display scale with tight tracking; one rule whose fill tracks speech energy.',
        strengths: [
            'Calmest of the five over a long working day',
            'Strongest state legibility with colour removed',
            'Lowest performance and accessibility risk by a wide margin',
        ],
        risks: [
            'Least memorable; nothing about it says Happier specifically',
            'Display-scale status in a 320pt sidebar is a lot of vertical budget for one word',
        ],
        cost: 'low',
        Component: SlateConcept,
    },
    {
        id: 'tide',
        name: 'Tide',
        thesis: 'Voice is a substance with a surface, a volume, and inertia.',
        model: 'Object in a vessel. A meniscus deforms: drawn down and inward by your voice, domed upward by Happier’s.',
        strengths: [
            'Most expressive; interruption and turn-taking are physically readable',
            'Delegated work has a genuinely distinct look — still and deep, not a spinner',
            'Reads as alive without a single waveform bar',
        ],
        risks: [
            'The highest exhaustion risk of the five; must go near-still when nobody speaks',
            'Continuous surface motion beside a diff or terminal violates the concentration rule',
            'Vessel chrome reintroduces exactly the rounded container Aurora removes',
        ],
        cost: 'medium',
        Component: TideConcept,
    },
];

/** Which concepts mount as a floating layer rather than in the layout flow. */
export function placementFor(conceptId: string): 'inline' | 'overlay' {
    return conceptId === 'halo' || conceptId === 'orb' ? 'overlay' : 'inline';
}
