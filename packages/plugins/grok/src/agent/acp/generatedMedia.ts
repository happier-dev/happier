import { basename, dirname, extname, isAbsolute } from 'node:path';

import type { AgentAcpRuntimeDefinition } from '@happier-dev/plugin-sdk/agent-runtime';

const OFFICIAL_MEDIA_TYPES = new Set(['ImageGen', 'ImageEdit']);
const REQUIRED_KEYS = ['filename', 'path', 'session_folder', 'type'] as const;
const MAX_PATH_CODE_UNITS = 4_096;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactOfficialKeys(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === REQUIRED_KEYS.length
    && REQUIRED_KEYS.every((key, index) => keys[index] === key);
}

type GrokGeneratedMediaProjector = NonNullable<
  AgentAcpRuntimeDefinition['generatedMedia']
>['projectTerminalOutput'];

export const projectGrokGeneratedMedia: GrokGeneratedMediaProjector = ({
  rawOutput,
}) => {
  if (!isRecord(rawOutput) || !hasExactOfficialKeys(rawOutput)) return null;
  if (typeof rawOutput.type !== 'string' || !OFFICIAL_MEDIA_TYPES.has(rawOutput.type)) return null;
  if (
    typeof rawOutput.path !== 'string'
    || rawOutput.path.length === 0
    || rawOutput.path.length > MAX_PATH_CODE_UNITS
    || rawOutput.path.includes('\0')
    || !isAbsolute(rawOutput.path)
    || !SUPPORTED_IMAGE_EXTENSIONS.has(extname(rawOutput.path).toLowerCase())
  ) {
    return null;
  }
  if (
    typeof rawOutput.filename !== 'string'
    || rawOutput.filename.length === 0
    || rawOutput.filename !== basename(rawOutput.path)
    || typeof rawOutput.session_folder !== 'string'
    || rawOutput.session_folder.length === 0
  ) {
    return null;
  }
  const rootPath = dirname(rawOutput.path);
  if (rawOutput.session_folder !== basename(rootPath)) return null;
  return Object.freeze([
    Object.freeze({ rootPath, path: rawOutput.path }),
  ]);
};
