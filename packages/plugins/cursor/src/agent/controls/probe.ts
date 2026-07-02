import { parseCursorCliModelsOutput, type CursorCliModelDescriptor } from '../cli/models.js';

export type CursorSessionControlsProbeResult = Readonly<{
  models: readonly CursorCliModelDescriptor[];
  modes: readonly string[];
  configOptions: readonly string[];
}>;

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function buildCursorSessionControlsProbeResult(params: Readonly<{
  modelsOutput: string;
  acpModes: readonly string[];
  acpConfigOptions: readonly string[];
}>): CursorSessionControlsProbeResult {
  return {
    models: parseCursorCliModelsOutput(params.modelsOutput),
    modes: uniqueStrings(params.acpModes),
    configOptions: uniqueStrings(params.acpConfigOptions),
  };
}
