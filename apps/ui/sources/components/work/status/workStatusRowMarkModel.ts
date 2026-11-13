import type { WorkStatusPresentation } from './resolveWorkStatusTone';

/**
 * What a work list row's status slot shows (owner ruling 2026-11-01, "Session list status: calm by default, like
 * 0.2"). Calm rows (idle, finished and seen, stopped, offline, usage-limited) show nothing, so the slot gives the row
 * back its age; news is a small ink dot; working is the spinner; needs you is the amber dot; failure the rose dot.
 * The state word stays in the tooltip, peek and accessible label, and on the row only when status words are on.
 * Sessions, Runs, Workflows and Discussions rows all decide their slot here; glyph surfaces (deployment steps,
 * headers) keep `WorkStatusGlyph`.
 */
export type WorkStatusRowMark = 'none' | 'news' | 'working' | 'attention' | 'danger';

const NEWS_STATES: ReadonlySet<string> = new Set(['unread', 'mentioned', 'finished_unseen']);

export function resolveWorkStatusRowMark(status: WorkStatusPresentation): WorkStatusRowMark {
    if (status.tone === 'danger') return 'danger';
    if (status.tone === 'attention') return 'attention';
    if (status.bucket === 'working') return 'working';
    return NEWS_STATES.has(status.state) ? 'news' : 'none';
}

/**
 * 0.2's playful working words (restored by owner amendment 2026-11-01): with status words on and the Account's
 * `sessionListWorkingStatusAnimatedTextEnabled`, a working row says one of these instead of its plain word. The
 * list is 0.2's own, kept verbatim as product voice.
 */
const PLAYFUL_WORKING_WORDS = ['Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Booping', 'Brewing', 'Calculating',
    'Cerebrating', 'Channelling', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Computing', 'Combobulating', 'Concocting',
    'Conjuring', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Deciphering', 'Deliberating',
    'Determining', 'Discombobulating', 'Divining', 'Doing', 'Effecting', 'Elucidating', 'Enchanting', 'Envisioning', 'Finagling',
    'Flibbertigibbeting', 'Forging', 'Forming', 'Frolicking', 'Generating', 'Germinating', 'Hatching', 'Herding', 'Honking',
    'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Manifesting', 'Marinating', 'Meandering', 'Moseying', 'Mulling',
    'Mustering', 'Musing', 'Noodling', 'Percolating', 'Perusing', 'Philosophising', 'Pontificating', 'Pondering', 'Processing',
    'Puttering', 'Puzzling', 'Reticulating', 'Ruminating', 'Scheming', 'Schlepping', 'Shimmying', 'Simmering', 'Smooshing',
    'Spelunking', 'Spinning', 'Stewing', 'Sussing', 'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling',
    'Unravelling', 'Vibing', 'Wandering', 'Whirring', 'Wibbling', 'Wizarding', 'Working', 'Wrangling'] as const;

/** A row's status word: its plain word, or for a working row with the preference on, a stable playful verb per row. */
export function resolveWorkStatusRowWord(status: WorkStatusPresentation, options: Readonly<{ animatedWorkingText: boolean; seed: string }>): string {
    if (!options.animatedWorkingText || status.bucket !== 'working' || status.tone !== 'neutral') return status.word;
    let hash = 0;
    for (let index = 0; index < options.seed.length; index += 1) hash = (hash * 31 + options.seed.charCodeAt(index)) >>> 0;
    return `${PLAYFUL_WORKING_WORDS[hash % PLAYFUL_WORKING_WORDS.length]!.toLowerCase()}…`;
}
