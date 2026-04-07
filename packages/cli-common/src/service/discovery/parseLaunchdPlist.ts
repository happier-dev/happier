import type { ParsedLaunchdPlist } from './serviceDiscoveryTypes.js';
import {
  basenameWithoutSuffix,
  captureSingleXmlValue,
  captureXmlBlock,
  captureXmlBoolean,
  captureXmlInt,
  captureXmlStrings,
} from './_shared.js';

export function parseLaunchdPlist(params: Readonly<{
  contents: string;
  sourcePath?: string;
}>): ParsedLaunchdPlist | null {
  const text = String(params.contents ?? '');
  const label = captureSingleXmlValue({ text, key: 'Label', valueTag: 'string' }) ?? basenameWithoutSuffix(params.sourcePath, '.plist');
  if (!label) return null;

  const programArgsBlock = captureXmlBlock({ text, key: 'ProgramArguments', tag: 'array' });
  const programArgs = programArgsBlock ? captureXmlStrings(programArgsBlock) : [];
  if (programArgs.length === 0) return null;

  const envBlock = captureXmlBlock({ text, key: 'EnvironmentVariables', tag: 'dict' });
  const envEntries = envBlock ? [...envBlock.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gi)] : [];
  const env: Record<string, string> = {};
  for (const entry of envEntries) {
    const key = String(entry[1] ?? '').trim();
    if (!key) continue;
    env[key] = String(entry[2] ?? '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&');
  }

  const startIntervalSec = captureXmlInt({ text, key: 'StartInterval' });
  const calendarBlock = captureXmlBlock({ text, key: 'StartCalendarInterval', tag: 'dict' });
  const calendarHour = calendarBlock
    ? Number((/<key>Hour<\/key>\s*<integer>([\s\S]*?)<\/integer>/i.exec(calendarBlock)?.[1] ?? '').trim())
    : Number.NaN;
  const calendarMinute = calendarBlock
    ? Number((/<key>Minute<\/key>\s*<integer>([\s\S]*?)<\/integer>/i.exec(calendarBlock)?.[1] ?? '').trim())
    : Number.NaN;
  const startCalendarInterval = Number.isFinite(calendarHour) && Number.isFinite(calendarMinute)
    ? { hour: Math.trunc(calendarHour), minute: Math.trunc(calendarMinute) }
    : null;

  return {
    kind: 'launchd-plist',
    label,
    programArgs,
    env,
    workingDirectory: captureSingleXmlValue({ text, key: 'WorkingDirectory', valueTag: 'string' }) ?? null,
    stdoutPath: captureSingleXmlValue({ text, key: 'StandardOutPath', valueTag: 'string' }) ?? null,
    stderrPath: captureSingleXmlValue({ text, key: 'StandardErrorPath', valueTag: 'string' }) ?? null,
    runAtLoad: captureXmlBoolean({ text, key: 'RunAtLoad' }) ?? false,
    keepAliveOnFailure: captureXmlBlock({ text, key: 'KeepAlive', tag: 'dict' }) !== null,
    startIntervalSec,
    startCalendarInterval,
  };
}
