import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { spawnTestProcess } from '@/testkit/process/spawn';

// A fresh process observes real module preparation and synchronous composition.
// Collection, rather than a command deadline, owns cold source preparation.
const observation = await observeDependencyComposition();

async function observeDependencyComposition() {
  const cliRoot = projectPath();
  const owner = pathToFileURL(join(cliRoot, 'src/session/actions/createCliActionDeps.ts')).href;
  const credentialOwner = pathToFileURL(join(cliRoot, 'src/session/actions/createCliActionExecutorFromCredentials.ts')).href;
  const child = spawnTestProcess(process.execPath, [
    '--conditions=happier-source',
    '--import', pathToFileURL(join(cliRoot, '../../packages/cli-common/registerSourceRuntime.mjs')).href,
    '--input-type=module', '--eval', `
      import { Session } from 'node:inspector';
      const inspector = new Session();
      const scripts = [];
      inspector.connect();
      inspector.on('Debugger.scriptParsed', ({ params }) => scripts.push(params.url.split('?')[0]));
      await new Promise((resolve, reject) => inspector.post('Debugger.enable', error => error ? reject(error) : resolve()));
      scripts.length = 0;
      const { createCliActionDeps } = await import(${JSON.stringify(owner)});
      const deps = createCliActionDeps({ token: 'factory-cost-fixture',
        credentials: { token: 'factory-cost-fixture', encryption: null },
        sessionId: 'cli-global', mode: 'plain', ctx: null,
        serverId: 'factory-cost-home', serverHttpBaseUrl: 'http://127.0.0.1:1' });
      const defaultPreview = { kind: 'factory-cost-preview' };
      const preview = await deps.buildApprovalPreview({ actionId: 'artifact.publish_from_file',
        input: { path: 'fixture.pdf', mime: 'application/pdf' },
        context: { surface: 'agent', defaultSessionId: 'factory-cost-session' }, defaultPreview });
      const dependencyScripts = [...scripts];
      const { createCliActionExecutorFromCredentials } = await import(${JSON.stringify(credentialOwner)});
      const executor = createCliActionExecutorFromCredentials({
        credentials: { token: 'factory-cost-fixture', encryption: null },
        serverId: 'factory-cost-home', serverApiUrl: 'http://127.0.0.1:1' });
      inspector.disconnect();
      process.stdout.write(JSON.stringify({ scripts: dependencyScripts, credentialScripts: scripts,
        credentialSynchronous: !(executor instanceof Promise), executorPorts: Object.keys(executor), synchronous: !(deps instanceof Promise),
        previewUnchanged: preview === defaultPreview, ports: Object.keys(deps) }) + '\\n');
    `,
  ], { cwd: cliRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  const errors: string[] = [];
  child.stdout?.on('data', chunk => output.push(String(chunk)));
  child.stderr?.on('data', chunk => errors.push(String(chunk)));
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`Action dependency observation exited ${code}: ${errors.join('')}`);
  return JSON.parse(output.join('')) as { scripts: string[]; credentialScripts: string[];
    credentialSynchronous: boolean; executorPorts: string[]; synchronous: boolean; previewUnchanged: boolean; ports: string[] };
}

it('constructs Action ports synchronously without loading unrelated executable families', () => {
  expect(observation.synchronous).toBe(true);
  expect(observation.previewUnchanged).toBe(true);
  expect(observation.ports).toContain('sessionSpawnNew');
  // Shared refusal/currentness support uses the same public error class,
  // without evaluating the SDK's root contribution facade.
  expect(observation.scripts.some(url => /\/packages\/plugin-sdk\/(?:src|dist)\/errors\.(?:ts|js)$/.test(url))).toBe(true);
  const forbidden = observation.scripts.filter(url =>
    /\/packages\/agents\/(?:src|dist)\//.test(url)
    || /\/packages\/plugin-sdk\/(?:src|dist)\/index\.(?:ts|js)$/.test(url)
    || /\/packages\/sdk\/(?:src|dist)\//.test(url)
    || /\/packages\/channels-protocol\/(?:src|dist)\/v1\/(?:index\.|provider\/)/.test(url)
    || /\/packages\/plugins\/[^/]+\/(?:src|dist)\/(?:agent|provider)\//.test(url)
    || /\/apps\/cli\/src\/daemon\/workflows\/(?:production|coordinator)\.ts$/.test(url)
    || /\/apps\/cli\/src\/providers\/connections\/runtimeServices\.ts$/.test(url)
    || /\/apps\/cli\/src\/agent\/catalog\/(?:snapshot|registry)\.ts$/.test(url)
    // Configuration shares this AsyncLocalStorage context; it imports no executable Agent runtime.
    || (/\/apps\/cli\/src\/agent\/(?:runtime|tools)\//.test(url)
      && !/\/apps\/cli\/src\/agent\/runtime\/lifecycle\/hostedSessionScope\.ts$/.test(url))
    || /\/apps\/cli\/src\/plugins\/projection\/registry\/(?:createResolvedContributionRegistry|resolveBuiltInContributions|resolvePluginContributions)\.ts$/.test(url)
    || /\/apps\/cli\/src\/plugins\/devLoop\/(?:installApprovalPreview|actions)\.ts$/.test(url)
    || /\/apps\/cli\/src\/registries\/createCliRegistryHost\.ts$/.test(url)
    || /\/apps\/cli\/src\/plugins\/store\/marketplace\/service\.ts$/.test(url)
    || /\/apps\/cli\/src\/session\/services\/createSpawnedSession\.ts$/.test(url));
  expect(forbidden, JSON.stringify(forbidden, null, 2)).toEqual([]);
});

it('constructs the credentialed executor without loading unrelated Action family implementations or catalogs', () => {
  expect(observation.credentialSynchronous).toBe(true);
  expect(observation.executorPorts).toEqual(expect.arrayContaining(['execute', 'prepare', 'bindInvocation', 'resolveSessionTarget']));
  expect(observation.credentialScripts.some(url => /\/createCliActionExecutorFromCredentials\.ts$/.test(url))).toBe(true);
  const unrelatedFamilies = observation.credentialScripts.filter(url =>
    /\/daemon\/externalActions\/daemonExternalActionTargetResolver\.ts$/.test(url)
    || /\/packages\/agents\/(?:src|dist)\//.test(url)
    || /\/packages\/plugin-sdk\/(?:src|dist)\/index\.(?:ts|js)$/.test(url)
    || /\/packages\/channels-protocol\/(?:src|dist)\/v1\/(?:index\.|provider\/)/.test(url)
    || /\/apps\/cli\/src\/agent\/catalog\//.test(url)
    || /\/api\/session\/transcriptQueries\.ts$/.test(url)
    || /\/session\/services\/spawnConnectedServicesDefaults\.ts$/.test(url)
    || /\/(?:executeAccountPluginAction|executeContributedAction)\.ts$/.test(url));
  expect(unrelatedFamilies, JSON.stringify(unrelatedFamilies, null, 2)).toEqual([]);
});
