import { open } from 'node:fs/promises';

import {
  parseHomeTargetInput,
  type HomeTargetInput,
} from '@happier-dev/cli-common/homeTarget';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';

import { resolveAbsolutePathFromWorkingDirectory } from '@/utils/path/expandHomeDirPath';

export const CLI_HOME_DESCRIPTOR_MAX_BYTES = 64 * 1024;

export type CliHomeTargetSource =
  | '--home'
  | '--home-url'
  | '--home-descriptor-file'
  | '--server'
  | '--server-url'
  | '--relay-url';

export type ParsedCliHomeTargetArgs = Readonly<{
  target: HomeTargetInput | null;
  source: CliHomeTargetSource | null;
  rest: string[];
}>;

type ReadDescriptorText = (source: string, maxBytes: number) => Promise<string>;

type TargetFlagOccurrence = Readonly<{ flag: CliHomeTargetSource; value: string }>;
type ModifierFlagOccurrence = Readonly<{
  flag: '--local-server-url' | '--webapp-url';
  value: string;
}>;
type ParsedFlagOccurrence = TargetFlagOccurrence | ModifierFlagOccurrence;

function isModifierFlagOccurrence(value: ParsedFlagOccurrence): value is ModifierFlagOccurrence {
  return value.flag === '--local-server-url' || value.flag === '--webapp-url';
}

function readFlagOccurrence(
  args: readonly string[],
  index: number,
): Readonly<{ occurrence: ParsedFlagOccurrence; consumed: number }> | null {
  const current = String(args[index] ?? '');
  const flags: readonly ParsedFlagOccurrence['flag'][] = [
    '--home',
    '--home-url',
    '--home-descriptor-file',
    '--server',
    '--server-url',
    '--relay-url',
    '--local-server-url',
    '--webapp-url',
  ];
  for (const flag of flags) {
    if (current === flag) {
      const value = String(args[index + 1] ?? '').trim();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      return { occurrence: { flag, value }, consumed: 2 };
    }
    if (current.startsWith(`${flag}=`)) {
      const value = current.slice(flag.length + 1).trim();
      if (!value) throw new Error(`Missing value for ${flag}`);
      return { occurrence: { flag, value }, consumed: 1 };
    }
  }
  return null;
}

async function readBoundedDescriptorStream(
  source: AsyncIterable<unknown>,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Home descriptor input exceeds ${maxBytes} bytes.`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function readDescriptorTextDefault(source: string, maxBytes: number): Promise<string> {
  if (source === '-') return await readBoundedDescriptorStream(process.stdin, maxBytes);
  const resolvedPath = resolveAbsolutePathFromWorkingDirectory(source);
  if (!resolvedPath) throw new Error('Home descriptor path is empty.');
  const handle = await open(resolvedPath, 'r');
  try {
    return await readBoundedDescriptorStream(
      handle.createReadStream({ autoClose: false, highWaterMark: 16 * 1024 }),
      maxBytes,
    );
  } finally {
    await handle.close();
  }
}

function parseDescriptorJson(raw: string): HomeTargetInput {
  if (Buffer.byteLength(raw, 'utf8') > CLI_HOME_DESCRIPTOR_MAX_BYTES) {
    throw new Error(`Home descriptor input exceeds ${CLI_HOME_DESCRIPTOR_MAX_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Home descriptor file is not valid JSON.');
  }
  const parsed = HomeConnectionDescriptorV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Home descriptor file does not contain a strict HomeConnectionDescriptorV1.');
  }
  return parseHomeTargetInput({
    kind: 'descriptor',
    descriptor: parsed.data,
    authority: 'trusted_enrollment',
  });
}

/**
 * Parses every public and retained setup Home-target spelling before callers
 * perform profile, credential, service, or runtime mutation.
 */
export async function parseCliHomeTargetArgs(
  args: readonly string[],
  options: Readonly<{ readDescriptorText?: ReadDescriptorText }> = {},
): Promise<ParsedCliHomeTargetArgs> {
  const targetOccurrences: TargetFlagOccurrence[] = [];
  const modifiers: ModifierFlagOccurrence[] = [];
  const rest: string[] = [];

  for (let index = 0; index < args.length;) {
    const parsed = readFlagOccurrence(args, index);
    if (!parsed) {
      rest.push(String(args[index] ?? ''));
      index += 1;
      continue;
    }
    if (isModifierFlagOccurrence(parsed.occurrence)) {
      modifiers.push(parsed.occurrence);
    } else {
      targetOccurrences.push(parsed.occurrence);
    }
    index += parsed.consumed;
  }

  if (targetOccurrences.length > 1) {
    throw new Error('Use only one explicit Home target: --home-descriptor-file, --home, or --home-url.');
  }
  if (modifiers.filter((entry) => entry.flag === '--local-server-url').length > 1) {
    throw new Error('Use --local-server-url only once.');
  }
  if (modifiers.filter((entry) => entry.flag === '--webapp-url').length > 1) {
    throw new Error('Use --webapp-url only once.');
  }

  const selected = targetOccurrences[0] ?? null;
  if (!selected) {
    if (modifiers.some((entry) => entry.flag === '--webapp-url')) {
      throw new Error('Cannot use --webapp-url without --home-url');
    }
    if (modifiers.some((entry) => entry.flag === '--local-server-url')) {
      throw new Error('Cannot use --local-server-url without --home-url');
    }
    return { target: null, source: null, rest };
  }

  if (selected.flag === '--home-descriptor-file') {
    if (modifiers.length > 0) {
      throw new Error('Descriptor Home targets cannot use URL override flags.');
    }
    const readDescriptorText = options.readDescriptorText ?? readDescriptorTextDefault;
    const raw = await readDescriptorText(selected.value, CLI_HOME_DESCRIPTOR_MAX_BYTES);
    return {
      target: parseDescriptorJson(raw),
      source: selected.flag,
      rest,
    };
  }

  if (selected.flag === '--home' || selected.flag === '--server') {
    if (modifiers.length > 0) {
      throw new Error('Saved Home targets cannot use URL override flags.');
    }
    return {
      target: parseHomeTargetInput({ kind: 'saved_profile', profileRef: selected.value }),
      source: selected.flag,
      rest,
    };
  }

  const localUrl = modifiers.find((entry) => entry.flag === '--local-server-url')?.value;
  const webappUrl = modifiers.find((entry) => entry.flag === '--webapp-url')?.value;
  return {
    target: parseHomeTargetInput({
      kind: 'https_url',
      url: selected.value,
      ...(localUrl ? { localUrl } : {}),
      ...(webappUrl ? { webappUrl } : {}),
    }),
    source: selected.flag,
    rest,
  };
}

/** Projects only URL/saved inputs into the established profile-selection owner. */
export function projectCliHomeTargetToServerSelectionArgs(target: HomeTargetInput): string[] {
  const parsed = parseHomeTargetInput(target);
  if (parsed.kind === 'saved_profile') return ['--server', parsed.profileRef];
  if (parsed.kind === 'descriptor') {
    throw new Error('Descriptor Home targets are adopted through the descriptor profile owner.');
  }
  return [
    '--server-url',
    parsed.url,
    ...(parsed.localUrl ? ['--local-server-url', parsed.localUrl] : []),
    ...(parsed.webappUrl ? ['--webapp-url', parsed.webappUrl] : []),
  ];
}
