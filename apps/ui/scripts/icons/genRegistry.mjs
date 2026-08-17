// Generates the icon registry from the verified concept mapping.
// Re-run after editing mapping.json; never hand-edit the generated file.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , mappingPath, outPath] = process.argv;
const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));

// Phosphor's canonical export for every icon is `<Name>Icon`. The bare alias also exists for most,
// but NOT where it would clash with a JS global (`Circle`, `Infinity`), so always use the suffix —
// one rule, and the clash class disappears.
const pascal = (kebab) => kebab.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') + 'Icon';
// Keyed by the PHOSPHOR name, not the old Ionicons/Octicons one. The mapping is a migration
// artifact — the app's vocabulary after this is Phosphor's, so carrying the old names forward as
// the public key would preserve exactly the split-brain the migration removes. Several old names
// collapse onto one Phosphor icon (Ionicons `git-branch-outline` and Octicons `git-branch` both
// became `git-branch`), which is the point.
// A concept may need its OWN key even though Phosphor draws it with an existing glyph, because the
// other family distinguishes them. `sidebar-right-open` is Phosphor's mirrored `sidebar-simple` but
// a dedicated right-edge glyph in HugeIcons, so the vocabulary has to carry the concept, not just
// the drawing. Aliases live in the mapping under a `#alias:` prefix.
const ALIAS_PREFIX = '#alias:';
const aliases = Object.entries(mapping)
    .filter(([k]) => k.startsWith(ALIAS_PREFIX))
    .map(([k, v]) => [k.slice(ALIAS_PREFIX.length), v]);
const canonical = [...new Set(
    Object.entries(mapping).filter(([k]) => !k.startsWith(ALIAS_PREFIX)).map(([, v]) => v),
)].sort().map((p) => [p, p]);
const entries = [...canonical, ...aliases].sort(([a], [b]) => (a < b ? -1 : 1));
const components = [...new Set(entries.map(([, p]) => pascal(p)))].sort();

const out = `// GENERATED — do not edit by hand.
// Source: scripts/icons/mapping.json  ·  Regenerate: node scripts/icons/genRegistry.mjs
//
// Only the icons this app actually uses are imported. Phosphor ships 1,512 icons; importing the
// whole catalogue would bundle ~12MB of path data, so the registry is the allowlist. Adding a new
// icon is a one-line addition to the mapping, which keeps the icon set curated on purpose.
import {
${components.map(c => `    ${c},`).join('\n')}
} from 'phosphor-react-native';
import type { Icon as PhosphorIcon } from 'phosphor-react-native';

export const ICON_REGISTRY = {
${entries.map(([k, v]) => `    '${k}': ${pascal(v)},`).join('\n')}
} as const satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof ICON_REGISTRY;
`;
writeFileSync(outPath, out);
console.log(`${entries.length} names -> ${components.length} distinct Phosphor components`);
