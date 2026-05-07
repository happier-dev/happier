#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

type Pixel = Readonly<{
  r: number;
  g: number;
  b: number;
  a: number;
}>;

type Point = Readonly<{
  x: number;
  y: number;
}>;

type Bounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type DecodedPng = Readonly<{
  width: number;
  height: number;
  pixels: Uint8Array;
}>;

type ParsedArgs = Readonly<{
  backgroundScreenshot: string | null;
  overlayScreenshot: string | null;
  settingsScreenshot: string | null;
  collapsedScreenshot: string | null;
  expandedScreenshot: string | null;
  clickThroughScreenshot: string | null;
  backendStateJson: string | null;
  nativeWindowStateJson: string | null;
  petBounds: Bounds | null;
  runId: string;
  json: boolean;
  help: boolean;
}>;

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../../..');
const defaultLogsRoot = resolve(repoRoot, '.project/logs/pets-blink-qa');

function printUsage(): string {
  return [
    'usage:',
    '  tsx apps/ui/scripts/qa/petsDesktopOverlayQa.ts \\',
    '    --background-screenshot <png> \\',
    '    --overlay-screenshot <png> \\',
    '    --pet-bounds <x,y,width,height>',
    '',
    'optional:',
    '  --settings-screenshot <png>',
    '  --collapsed-screenshot <png>',
    '  --expanded-screenshot <png>',
    '  --click-through-screenshot <png>',
    '  --backend-state-json <json>',
    '  --native-window-state-json <json>',
    '  --run-id <id>',
    '  --json',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'json' || key === 'help' || key === 'h') {
      flags.add(key === 'h' ? 'help' : key);
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, value);
    index += 1;
  }

  return {
    backgroundScreenshot: values.get('background-screenshot') ?? null,
    overlayScreenshot: values.get('overlay-screenshot') ?? null,
    settingsScreenshot: values.get('settings-screenshot') ?? null,
    collapsedScreenshot: values.get('collapsed-screenshot') ?? null,
    expandedScreenshot: values.get('expanded-screenshot') ?? null,
    clickThroughScreenshot: values.get('click-through-screenshot') ?? null,
    backendStateJson: values.get('backend-state-json') ?? null,
    nativeWindowStateJson: values.get('native-window-state-json') ?? null,
    petBounds: values.has('pet-bounds') ? parseBounds(values.get('pet-bounds') ?? '') : null,
    runId: values.get('run-id') ?? new Date().toISOString().replace(/[:.]/g, '-') + `-${randomUUID().slice(0, 8)}`,
    json: flags.has('json'),
    help: flags.has('help'),
  };
}

function parseBounds(raw: string): Bounds {
  const parts = raw.split(',').map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid --pet-bounds value: ${raw}`);
  }
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid --pet-bounds size: ${raw}`);
  }
  return { x, y, width, height };
}

function requirePngSignature(bytes: Buffer): void {
  if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error('Expected PNG screenshot bytes');
  }
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const p = left + above - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - above);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? above : upperLeft;
}

function decodePng(bytes: Buffer): DecodedPng {
  requirePngSignature(bytes);
  let offset = pngSignature.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width <= 0 || height <= 0) throw new Error('PNG is missing IHDR dimensions');
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const sourceBytesPerPixel = colorType === 6 ? 4 : 3;
  const sourceStride = width * sourceBytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const pixels = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(sourceStride);
  const current = new Uint8Array(sourceStride);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset] ?? -1;
    sourceOffset += 1;
    current.set(inflated.subarray(sourceOffset, sourceOffset + sourceStride));
    sourceOffset += sourceStride;

    for (let x = 0; x < sourceStride; x += 1) {
      const left = x >= sourceBytesPerPixel ? current[x - sourceBytesPerPixel] ?? 0 : 0;
      const above = previous[x] ?? 0;
      const upperLeft = x >= sourceBytesPerPixel ? previous[x - sourceBytesPerPixel] ?? 0 : 0;
      const raw = current[x] ?? 0;
      if (filter === 0) {
        current[x] = raw;
      } else if (filter === 1) {
        current[x] = (raw + left) & 0xff;
      } else if (filter === 2) {
        current[x] = (raw + above) & 0xff;
      } else if (filter === 3) {
        current[x] = (raw + Math.floor((left + above) / 2)) & 0xff;
      } else if (filter === 4) {
        current[x] = (raw + paethPredictor(left, above, upperLeft)) & 0xff;
      } else {
        throw new Error(`Unsupported PNG filter: ${filter}`);
      }
    }

    for (let x = 0; x < width; x += 1) {
      const source = x * sourceBytesPerPixel;
      const target = (y * width + x) * 4;
      pixels[target] = current[source] ?? 0;
      pixels[target + 1] = current[source + 1] ?? 0;
      pixels[target + 2] = current[source + 2] ?? 0;
      pixels[target + 3] = colorType === 6 ? current[source + 3] ?? 255 : 255;
    }

    previous.set(current);
  }

  return { width, height, pixels };
}

function pixelAt(image: DecodedPng, point: Point): Pixel {
  if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) {
    throw new Error(`Pixel sample out of bounds: ${point.x},${point.y}`);
  }
  const offset = (point.y * image.width + point.x) * 4;
  return {
    r: image.pixels[offset] ?? 0,
    g: image.pixels[offset + 1] ?? 0,
    b: image.pixels[offset + 2] ?? 0,
    a: image.pixels[offset + 3] ?? 0,
  };
}

function colorDistance(a: Pixel, b: Pixel): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a);
}

function isNearWhite(pixel: Pixel): boolean {
  return pixel.r >= 245 && pixel.g >= 245 && pixel.b >= 245 && pixel.a >= 245;
}

function clampPoint(image: DecodedPng, point: Point): Point {
  return {
    x: Math.max(0, Math.min(image.width - 1, point.x)),
    y: Math.max(0, Math.min(image.height - 1, point.y)),
  };
}

function buildOutsideSamplePoints(image: DecodedPng, bounds: Bounds): Point[] {
  return [
    { x: bounds.x - 2, y: bounds.y - 2 },
    { x: bounds.x + bounds.width + 2, y: bounds.y + Math.floor(bounds.height / 2) },
    { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + bounds.height + 2 },
    { x: bounds.x - 2, y: bounds.y + Math.floor(bounds.height / 2) },
  ].map((point) => clampPoint(image, point));
}

function buildInsideSamplePoints(image: DecodedPng, bounds: Bounds): Point[] {
  return [
    { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) },
    { x: bounds.x + Math.floor(bounds.width / 3), y: bounds.y + Math.floor(bounds.height / 2) },
    { x: bounds.x + Math.floor((bounds.width * 2) / 3), y: bounds.y + Math.floor(bounds.height / 2) },
  ].map((point) => clampPoint(image, point));
}

async function copyArtifact(inputPath: string | null, outputPath: string): Promise<string | null> {
  if (!inputPath) return null;
  await copyFile(inputPath, outputPath);
  return outputPath;
}

async function copyJsonArtifact(inputPath: string | null, outputPath: string): Promise<string> {
  if (!inputPath) {
    await writeFile(outputPath, JSON.stringify({ status: 'not_provided' }, null, 2) + '\n', 'utf8');
    return outputPath;
  }
  await copyFile(inputPath, outputPath);
  return outputPath;
}

async function runQa(args: ParsedArgs): Promise<Record<string, unknown>> {
  if (!args.backgroundScreenshot || !args.overlayScreenshot || !args.petBounds) {
    throw new Error('--background-screenshot, --overlay-screenshot, and --pet-bounds are required');
  }

  const outputDir = resolve(defaultLogsRoot, args.runId);
  await mkdir(outputDir, { recursive: true });

  const background = decodePng(await readFile(args.backgroundScreenshot));
  const overlay = decodePng(await readFile(args.overlayScreenshot));
  if (background.width !== overlay.width || background.height !== overlay.height) {
    throw new Error('Background and overlay screenshots must have identical dimensions');
  }

  const outsideSamples = buildOutsideSamplePoints(overlay, args.petBounds).map((point) => {
    const overlayPixel = pixelAt(overlay, point);
    const backgroundPixel = pixelAt(background, point);
    return {
      point,
      overlayPixel,
      backgroundPixel,
      distance: colorDistance(overlayPixel, backgroundPixel),
      matchesBackground: colorDistance(overlayPixel, backgroundPixel) <= 2,
      suspiciousWhiteFill: isNearWhite(overlayPixel) && !isNearWhite(backgroundPixel),
    };
  });

  const insideSamples = buildInsideSamplePoints(overlay, args.petBounds).map((point) => {
    const overlayPixel = pixelAt(overlay, point);
    const backgroundPixel = pixelAt(background, point);
    return {
      point,
      overlayPixel,
      backgroundPixel,
      distance: colorDistance(overlayPixel, backgroundPixel),
      differsFromBackground: colorDistance(overlayPixel, backgroundPixel) > 12,
    };
  });

  const outsidePass = outsideSamples.every((sample) => sample.matchesBackground && !sample.suspiciousWhiteFill);
  const insidePass = insideSamples.some((sample) => sample.differsFromBackground);
  const ok = outsidePass && insidePass;

  const artifacts = {
    settings: await copyArtifact(args.settingsScreenshot, resolve(outputDir, '01-settings-pets.png')),
    overlay: await copyArtifact(args.overlayScreenshot, resolve(outputDir, '02-overlay-route-transparent.png')),
    collapsed: await copyArtifact(args.collapsedScreenshot, resolve(outputDir, '03-overlay-collapsed.png')),
    expanded: await copyArtifact(args.expandedScreenshot, resolve(outputDir, '04-overlay-expanded.png')),
    clickThrough: await copyArtifact(args.clickThroughScreenshot, resolve(outputDir, '05-overlay-click-through.png')),
    backendState: await copyJsonArtifact(args.backendStateJson, resolve(outputDir, 'backend-state.json')),
    nativeWindowState: await copyJsonArtifact(args.nativeWindowStateJson, resolve(outputDir, 'native-window-state.json')),
    result: resolve(outputDir, 'qa-result.json'),
  };

  const result = {
    ok,
    outputDir,
    petBounds: args.petBounds,
    outsidePass,
    insidePass,
    outsideSamples,
    insideSamples,
    artifacts,
  };
  await writeFile(artifacts.result, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return result;
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(printUsage() + '\n');
    return;
  }

  const result = await runQa(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`[pets-qa] result=${result.ok ? 'pass' : 'fail'} outputDir=${String(result.outputDir)}\n`);
  }
  if (result.ok !== true) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[pets-qa] ${message}\n`);
    process.exitCode = 1;
  });
}
