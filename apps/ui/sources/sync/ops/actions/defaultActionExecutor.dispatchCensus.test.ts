import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('has a dispatch path for every UI-declared Action', () => {
    const repo = new URL('../../../../../../', import.meta.url);
    const loader = fileURLToPath(new URL('packages/cli-common/registerSourceRuntime.mjs', repo));
    const audit = fileURLToPath(new URL('./defaultActionExecutor.dispatchCensus.mjs', import.meta.url));
    const output = execFileSync(process.execPath, ['--conditions=happier-source', '--import', loader, audit], {
        cwd: fileURLToPath(repo), encoding: 'utf8',
    });
    const { counts, missing } = JSON.parse(output);
    expect(missing, JSON.stringify(counts)).toEqual([]);
});
