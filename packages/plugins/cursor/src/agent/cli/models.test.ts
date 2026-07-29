import { describe, expect, it } from 'vitest';

import * as cursorCliModelsModule from './models.js';
import { parseCursorCliModelsOutput } from './models.js';

type CursorCliModelsExec = Parameters<typeof cursorCliModelsModule.readCursorCliModels>[0]['exec'];

type CursorCliModelsModuleWithReader = typeof cursorCliModelsModule & Readonly<{
  readCursorCliModels?: (params: Readonly<{
    exec: CursorCliModelsExec;
    executablePath: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  }>) => Promise<ReturnType<typeof parseCursorCliModelsOutput>>;
}>;

describe('parseCursorCliModelsOutput', () => {
  it('parses Cursor model rows with current and default markers', () => {
    expect(parseCursorCliModelsOutput([
      'Available models',
      '',
      'auto - Auto',
      'composer-2.5 - Composer 2.5',
      'composer-2.5-fast - Composer 2.5 Fast (current, default)',
      'Tip: use --model <id> to select a model',
    ].join('\n'))).toEqual([
      { id: 'auto', name: 'Auto', current: false, default: false },
      { id: 'composer-2.5', name: 'Composer 2.5', current: false, default: false },
      { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast', current: true, default: true },
    ]);
  });

  it('runs cursor models through exec before parsing descriptors', async () => {
    const launches: unknown[] = [];
    const exec: CursorCliModelsExec = {
      run: async (launch) => {
        launches.push(launch);
        return {
          exitCode: 0,
          signal: null,
          stdout: 'composer-2.5-fast - Composer 2.5 Fast (current, default)\n',
          stderr: '',
        };
      },
    };
    const modelsModule: CursorCliModelsModuleWithReader = cursorCliModelsModule;

    expect(modelsModule.readCursorCliModels).toBeTypeOf('function');
    const models = await modelsModule.readCursorCliModels?.({
      exec,
      executablePath: '/opt/cursor-agent',
      cwd: '/repo',
      env: { CURSOR_API_KEY: 'cursor-key' },
    });

    expect(models).toEqual([
      { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast', current: true, default: true },
    ]);
    expect(launches).toEqual([
      {
        kind: 'binary',
        executablePath: '/opt/cursor-agent',
        args: ['models'],
        cwd: '/repo',
        env: { CURSOR_API_KEY: 'cursor-key' },
      },
    ]);
  });
});
