import { rm } from 'node:fs/promises';

import {
  resolveServiceBackend,
  buildServiceDefinition,
  planServiceAction,
  applyServicePlan,
} from '@happier-dev/cli-common/service';

export { resolveServiceBackend, buildServiceDefinition, planServiceAction };

function normalizeLabel(spec) {
  const label = String(spec?.label ?? '').trim();
  if (!label) throw new Error('[service] missing label');
  return label;
}

function taskNameFor({ backend, label }) {
  if (String(backend).startsWith('schtasks-')) {
    return `Happier\\${label}`;
  }
  return '';
}

export async function installService({
  platform = process.platform,
  mode = 'user',
  homeDir = '',
  spec,
  persistent = true,
  uid = null,
} = {}) {
  const label = normalizeLabel(spec);
  const backend = resolveServiceBackend({ platform, mode });
  const definition = buildServiceDefinition({ backend, homeDir, spec });
  const taskName = taskNameFor({ backend, label });

  const plan = planServiceAction({
    backend,
    action: 'install',
    label,
    definitionPath: definition.path,
    definitionContents: definition.contents,
    taskName,
    persistent,
    uid,
  });
  await applyServicePlan(plan);
  return { backend, definitionPath: definition.path, taskName: taskName || null };
}

export async function uninstallService({
  platform = process.platform,
  mode = 'user',
  homeDir = '',
  spec,
  persistent = true,
  uid = null,
} = {}) {
  const label = normalizeLabel(spec);
  const backend = resolveServiceBackend({ platform, mode });
  const definition = buildServiceDefinition({ backend, homeDir, spec });
  const taskName = taskNameFor({ backend, label });

  const plan = planServiceAction({
    backend,
    action: 'uninstall',
    label,
    definitionPath: definition.path,
    definitionContents: definition.contents,
    taskName,
    persistent,
    uid,
  });
  await applyServicePlan(plan);
  await rm(definition.path, { force: true }).catch(() => {});
  return { backend, taskName: taskName || null };
}

export async function restartService({ platform = process.platform, mode = 'user', spec, persistent = true, uid = null } = {}) {
  const label = normalizeLabel(spec);
  const backend = resolveServiceBackend({ platform, mode });
  const taskName = taskNameFor({ backend, label });

  const plan = planServiceAction({
    backend,
    action: 'restart',
    label,
    taskName,
    persistent,
    uid,
  });
  await applyServicePlan(plan);
  return { backend };
}

