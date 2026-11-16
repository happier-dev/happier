import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import { prepareDatabaseMoveWriters } from './databaseMoveWriters';

const detail = createDeploymentEnvironmentDetailV1();
const content = { ...detail.content, definition: { kind: 'stored' as const, contentRevision: 1,
    composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['web', 'worker', 'database'],
    document: 'services: {web: {image: app}, worker: {image: app}, database: {image: postgres}}' } };
function service(name: string, phase: 'running' | 'stopped'): MachineServiceRowV1 {
    return { serviceId: `instance/${name}`, name, authority: 'project', lifecyclePurpose: 'deployment',
        generation: phase === 'running' ? 'generation' : null, state: phase,
        native: { phase, readiness: 'not_reported' }, environmentId: detail.environment.id,
        deployment: { deploymentId: 'live', installationId: 'installation', service: { kind: 'deployment',
            machineId: 'machine', environmentId: detail.environment.id, environmentInstanceId: 'instance',
            composeService: name, serviceId: `instance/${name}` } },
        capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false } };
}
const placement = { machineId: 'machine', installationId: 'installation', deploymentId: 'live' };

it.each(['running', 'stopped'] as const)('quiesces every exact running application service and preserves the %s worker and database', phase => {
    const result = prepareDatabaseMoveWriters(content, detail.environment.id, 'database', [{ ...placement,
        result: { kind: 'snapshot', services: [service('web', 'running'), service('worker', phase), service('database', 'running')] } }]);
    expect(result).toEqual({ kind: 'ready', writers: [{ machineId: 'machine', serviceId: 'instance/web', expectedGeneration: 'generation' },
        ...(phase === 'running' ? [{ machineId: 'machine', serviceId: 'instance/worker', expectedGeneration: 'generation' }] : [])],
        runningServices: phase === 'running' ? ['web', 'worker'] : ['web'],
        stopped: phase === 'stopped' ? [{ machineId: 'machine', serviceId: 'instance/worker', composeService: 'worker' }] : [] });
});

it.each(['missing', 'foreign-installation', 'unknown-native', 'missing-generation'] as const)(
    'requires explicit writer review for %s instead of guessing that source writes are stopped', problem => {
        const web = service('web', 'running');
        if (problem === 'foreign-installation') web.deployment!.installationId = 'replacement';
        if (problem === 'unknown-native') web.native = { phase: 'unknown', readiness: 'not_reported' };
        if (problem === 'missing-generation') web.generation = null;
        expect(prepareDatabaseMoveWriters(content, detail.environment.id, 'database', [{ ...placement,
            result: { kind: 'snapshot', services: [...(problem === 'missing' ? [] : [web]), service('worker', 'stopped')] } }]))
            .toEqual({ kind: 'unavailable', reason: 'writer_review_required' });
    });

it('keeps a stopped application stopped instead of starting it as a side effect of Move', () => {
    expect(prepareDatabaseMoveWriters(content, detail.environment.id, 'database', [{ ...placement,
        result: { kind: 'snapshot', services: [service('web', 'stopped'), service('worker', 'stopped')] } }]))
        .toEqual({ kind: 'unavailable', reason: 'noRunningWriter' });
});
