import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTemplates';
import { RegistryStarterCatalogV1Schema } from '@happier-dev/protocol/registries/registryStarterV1';

it('offers Coder with persistent PostgreSQL and a generated private database credential', () => {
  const catalog = JSON.parse(readFileSync(new URL('../resources/registry/apps.json', import.meta.url), 'utf8')) as { apps: { itemId: string; app: unknown }[] };
  const selected = catalog.apps.find(entry => entry.itemId === 'coder');
  expect(selected).toBeDefined();
  const app = DeploymentTemplateV1Schema.parse(selected?.app);
  const compose = JSON.parse(app.compose.document);
  expect(compose.services.coder.environment.CODER_PG_CONNECTION_URL).toContain('${DB_PASSWORD}');
  expect(compose.services.database.ports).toBeUndefined();
  expect(compose.services.coder.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock');
  expect(app.variables.find(variable => variable.key === 'DB_PASSWORD')).toMatchObject({ secret: true });
  expect(app.generatedSecrets).toContainEqual(expect.objectContaining({ key: 'DB_PASSWORD' }));
  expect(app.volumes).toContainEqual(expect.objectContaining({ service: 'database', persistent: true }));
  expect(app.variables.some(variable => /admin|token/i.test(variable.key))).toBe(false);
});
it('offers the official Docker workspace starter through the existing starter catalog', () => {
  const catalog = RegistryStarterCatalogV1Schema.parse(JSON.parse(readFileSync(new URL('../resources/registry/starters.json', import.meta.url), 'utf8')));
  expect(catalog.starters.find(entry => entry.itemId === 'coder-docker')?.starter).toMatchObject({ repository: 'https://github.com/coder/coder' });
});
