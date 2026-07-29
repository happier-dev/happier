type CursorLegacyCommandRunner = Readonly<{
  run(input: Readonly<{
    kind: 'binary';
    executablePath: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  }>): Promise<Readonly<{
    stdout: string;
    exitCode: number | null;
  }>>;
}>;

export type CursorCliModelDescriptor = Readonly<{
  id: string;
  name: string;
  current: boolean;
  default: boolean;
}>;

const CURSOR_MODELS_ARGS = Object.freeze(['models'] as const);
const MODEL_ROW_PATTERN = /^([^\s]+)\s+-\s+(.+)$/u;

function stripMarker(value: string, marker: string): string {
  return value.replace(new RegExp(`\\s*\\(${marker}\\)`, 'giu'), '').trim();
}

export function parseCursorCliModelsOutput(output: string): readonly CursorCliModelDescriptor[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .flatMap((line): CursorCliModelDescriptor[] => {
      const match = MODEL_ROW_PATTERN.exec(line);
      if (!match) return [];
      const id = match[1]?.trim() ?? '';
      const rawName = match[2]?.trim() ?? '';
      if (!id || !rawName || id === 'Tip:') return [];
      const current = /\(current(?:,\s*default)?\)/iu.test(rawName);
      const isDefault = /\((?:current,\s*)?default\)/iu.test(rawName);
      const name = stripMarker(stripMarker(stripMarker(rawName, 'current,\\s*default'), 'current'), 'default');
      return [{ id, name, current, default: isDefault }];
    });
}

export async function readCursorCliModels(params: Readonly<{
  exec: CursorLegacyCommandRunner;
  executablePath: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}>): Promise<readonly CursorCliModelDescriptor[]> {
  const result = await params.exec.run({
    kind: 'binary',
    executablePath: params.executablePath,
    args: CURSOR_MODELS_ARGS,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.env ? { env: params.env } : {}),
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return parseCursorCliModelsOutput(result.stdout);
}
