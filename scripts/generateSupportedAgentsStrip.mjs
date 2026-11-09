/**
 * Generates the README "supported agents" logo strip into `.github/`:
 *
 *   .github/supported-agents-light.svg / .png  — dark #57606a glyphs, for LIGHT backgrounds
 *   .github/supported-agents-dark.svg  / .png  — light #8b949e glyphs, for DARK backgrounds
 *
 * Source of truth: the exact per-agent monochrome SVG marks the app's pre-auth
 * welcome screen renders as a horizontal row
 * (`apps/ui/sources/components/onboarding/preAuth/ProviderMarkRow.tsx`). That row maps
 * `AGENT_IDS` (the generated bundled-plugin catalog order,
 * `packages/agents/src/generated/agentIds.ts`) through `AgentIcon`, whose SVG marks come
 * from the generated `AGENT_LOGO_SVG_XML` resolver map in
 * `apps/ui/sources/agents/registry/generatedAgentLogoSvgXml.ts`. The bundled-plugin
 * publisher builds that standalone map from plugin-owned SVG assets/declarations;
 * its imports are type-only, so this script can import it directly.
 *
 * Tinting replicates `AgentIcon.applySvgIconColor` (agents/registry/AgentIcon.tsx):
 * every fill/stroke (except fill="none") becomes the single strip color, so inherently
 * colored marks stay monochrome exactly as in the app. Agents whose generated UI entry
 * has `svgIconXml: null` (no mark to draw — e.g. coderabbit, deepsec) are skipped and
 * listed on stdout.
 *
 * Regenerate with:  pnpm run generate:agents-strip
 *             (or:  node --experimental-strip-types scripts/generateSupportedAgentsStrip.mjs)
 *
 * PNGs are rasterized at 2x for retina README rendering, via the repo's `sharp`
 * dependency. If sharp's native binding is unavailable on this machine (e.g. the
 * workspace was installed for another platform), the SVGs are still written and exact
 * PNG instructions are printed; you can point the script at any working sharp install
 * with SUPPORTED_AGENTS_STRIP_SHARP=/path/to/node_modules/sharp.
 *
 * README.md consumes the PNGs through a <picture> element that switches the light/dark
 * variant on `prefers-color-scheme`. Idempotent: overwrites the four files, nothing else.
 */

import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_IDS } from '../packages/agents/src/generated/agentIds.ts';
import { AGENT_LOGO_SVG_XML } from '../apps/ui/sources/agents/registry/generatedAgentLogoSvgXml.ts';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

const OUT_DIR = path.join(repoRoot, '.github');

// Layout (1x units). Mirrors the welcome row's rhythm (square glyph boxes, even gaps):
// 28px glyph boxes inside 44px-tall rows, laid out on TWO centered rows for the README
// (a single long line renders each mark too small at README width), rasterized at 2x.
const GLYPH_SIZE = 28;
const GLYPH_GAP = 40;
const PAD_X = 10;
const ROW_HEIGHT = 44;
const ROWS = 2;
const PNG_SCALE = 2;

// Marks excluded from the README strip. `customAcp` is the neutral "bring your own ACP
// CLI" placeholder glyph, not a real agent brand; the welcome screen shows it, the
// README should not (founder decision, 2026-09-21). The bundled catalog on this line
// does not list it in AGENT_IDS, so the entry is a guard, not an active filter.
const EXCLUDED_AGENT_IDS = new Set(['customAcp']);

const VARIANTS = Object.freeze([
  { name: 'supported-agents-light', color: '#1f2328', note: 'dark glyphs / light background (GitHub light-mode text color)' },
  { name: 'supported-agents-dark', color: '#e6edf3', note: 'light glyphs / dark background (GitHub dark-mode text color)' },
]);

// Same pattern as AgentIcon.applySvgIconColor (agents/registry/AgentIcon.tsx): re-tint
// every fill/stroke attribute except fill="none"; `fill-rule` etc. are untouched because
// the pattern requires `="` right after the attribute name.
const SVG_COLOR_ATTRIBUTE_PATTERN = /\s(fill|stroke)="(?!none\b)[^"]*"/g;

function applySvgIconColor(svgXml, color) {
  return svgXml.replace(SVG_COLOR_ATTRIBUTE_PATTERN, (_match, attribute) => ` ${attribute}="${color}"`);
}

function loadSharp() {
  const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
  const candidates = [];
  if (process.env.SUPPORTED_AGENTS_STRIP_SHARP) {
    candidates.push(process.env.SUPPORTED_AGENTS_STRIP_SHARP);
  }
  candidates.push('sharp');
  let lastError;
  for (const candidate of candidates) {
    try {
      const loaded = requireFromRoot(candidate);
      return { sharp: loaded, from: candidate };
    } catch (error) {
      lastError = error;
    }
  }
  return { sharp: null, error: lastError };
}

/**
 * Split `count` glyphs into ROWS rows, longer rows first (9 + 9 for 18), each row
 * horizontally centered within the widest row.
 */
function rowLayout(count) {
  const base = Math.floor(count / ROWS);
  const remainder = count % ROWS;
  const rows = Array.from({ length: ROWS }, (_row, i) => base + (i < remainder ? 1 : 0));
  return rows.filter((n) => n > 0);
}

function rowWidth(n) {
  return n * GLYPH_SIZE + (n - 1) * GLYPH_GAP;
}

function buildStripSvg(glyphs, { width, height }) {
  const rows = rowLayout(glyphs.length);
  const maxRowWidth = Math.max(...rows.map(rowWidth));
  const cells = [];
  let cursor = 0;
  rows.forEach((rowCount, rowIndex) => {
    const xStart = PAD_X + (maxRowWidth - rowWidth(rowCount)) / 2;
    const y = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - GLYPH_SIZE) / 2;
    for (let i = 0; i < rowCount; i += 1) {
      const { agentId, xml } = glyphs[cursor];
      cursor += 1;
      const x = xStart + i * (GLYPH_SIZE + GLYPH_GAP);
      // Nest each mark as an inner <svg> so its own viewBox keeps scaling + centering it
      // inside a square box, exactly like AgentIcon's fixed-size SvgXml box. Some marks
      // (e.g. antigravity) carry their own width/height on the root tag; strip those
      // from the ROOT TAG ONLY (inner <filter> etc. keep theirs) so the injected box
      // wins instead of redefining the attributes, which is an XML error.
      const rootTagEnd = xml.indexOf('>');
      const rootTag = xml.slice(0, rootTagEnd + 1).replace(/\s(?:width|height)="[^"]*"/g, '');
      const cleaned = rootTag + xml.slice(rootTagEnd + 1);
      const positioned = cleaned.replace(
        '<svg ',
        `<svg x="${x}" y="${y}" width="${GLYPH_SIZE}" height="${GLYPH_SIZE}" `,
      );
      cells.push(`  <!-- ${agentId} -->\n  ${positioned}`);
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" role="img" aria-label="Supported AI coding agents">`,
    cells.join('\n'),
    '</svg>',
    '',
  ].join('\n');
}

let VIEW_WIDTH = 0;
let VIEW_HEIGHT = 0;

async function main() {
  const agentIds = AGENT_IDS;

  const skipped = [];
  const rendered = [];
  for (const agentId of agentIds) {
    if (EXCLUDED_AGENT_IDS.has(agentId)) { skipped.push(`${agentId} (excluded)`); continue; }
    const resolver = AGENT_LOGO_SVG_XML[agentId] ?? null;
    if (!resolver) { skipped.push(`${agentId} (no SVG mark)`); continue; }
    rendered.push({ agentId, resolver });
  }
  if (rendered.length === 0) throw new Error('No agent logo resolvers found.');

  const rows = rowLayout(rendered.length);
  VIEW_WIDTH = PAD_X * 2 + Math.max(...rows.map(rowWidth));
  VIEW_HEIGHT = rows.length * ROW_HEIGHT;

  const { sharp, from: sharpFrom, error: sharpError } = loadSharp();
  const written = [];

  for (const variant of VARIANTS) {
    // The resolvers take the app theme and read colour leaves off it
    // (`theme.colors.text.primary`, and e.g. `theme.colors.accent.orange` /
    // `theme.colors.surface.base` for ohMyPi). In the app the welcome row hands
    // AgentIcon a tint colour, whose applySvgIconColor pass overwrites every one
    // of those fills with the single tint anyway — so feeding EVERY theme leaf
    // the strip colour, plus the same re-tint pass below, reproduces the app
    // pipeline exactly. A recursive Proxy keeps this robust to new theme reads.
    const themeLeaf = (color) => new Proxy(function () {}, {
      get: (_target, prop) => {
        if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
          return () => color;
        }
        return themeLeaf(color);
      },
    });
    const theme = themeLeaf(variant.color);
    const glyphs = rendered.map(({ agentId, resolver }) => ({
      agentId,
      xml: applySvgIconColor(resolver(theme), variant.color),
    }));

    const svg1x = buildStripSvg(glyphs, { width: VIEW_WIDTH, height: VIEW_HEIGHT });
    const svgPath = path.join(OUT_DIR, `${variant.name}.svg`);
    await writeFile(svgPath, svg1x, 'utf8');
    written.push(`${path.relative(repoRoot, svgPath)} (${VIEW_WIDTH}x${VIEW_HEIGHT})`);

    if (sharp) {
      const svg2x = buildStripSvg(glyphs, {
        width: VIEW_WIDTH * PNG_SCALE,
        height: VIEW_HEIGHT * PNG_SCALE,
      });
      const pngPath = path.join(OUT_DIR, `${variant.name}.png`);
      await sharp(Buffer.from(svg2x)).png().toFile(pngPath);
      written.push(`${path.relative(repoRoot, pngPath)} (${VIEW_WIDTH * PNG_SCALE}x${VIEW_HEIGHT * PNG_SCALE})`);
    }
  }

  console.log(`Rendered ${rendered.length} agent marks (bundled-catalog AGENT_IDS order):`);
  console.log(`  ${rendered.map((g) => g.agentId).join(', ')}`);
  if (skipped.length > 0) console.log(`Skipped: ${skipped.join(', ')}`);
  console.log('Wrote:');
  for (const file of written) console.log(`  ${file}`);
  if (sharp) {
    console.log(`PNG rasterizer: sharp (resolved via ${sharpFrom === 'sharp' ? 'workspace root node_modules' : sharpFrom})`);
  } else {
    console.warn('\nWARNING: sharp could not be loaded on this machine — SVGs written, PNGs skipped.');
    if (sharpError) console.warn(`  (${String(sharpError.message).split('\n')[0]})`);
    console.warn('  To produce the PNGs, either:');
    console.warn('    - re-run inside the dev VM / any machine where the workspace sharp install matches the platform, or');
    console.warn('    - SUPPORTED_AGENTS_STRIP_SHARP=/path/to/node_modules/sharp pnpm run generate:agents-strip, or');
    console.warn(`    - rsvg-convert -w ${VIEW_WIDTH * PNG_SCALE} .github/supported-agents-light.svg -o .github/supported-agents-light.png (and the dark variant).`);
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
