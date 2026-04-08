import { basename } from 'node:path';

import type { CommandContext } from '@/cli/commandRegistry';
import { uninstallDaemonService } from '@/daemon/service/installer';
import {
  discoverHappierInstallations,
  discoverHappierServices,
  isHappierRuntimePathWithinRoot,
  normalizeHappierRuntimePath,
  type HappierService,
} from '@happier-dev/cli-common/happierRuntime';
import { uninstallManagedFirstPartyComponent } from '@happier-dev/cli-common/firstPartyRuntime';
import { cmd, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';
import { normalizePublicReleaseRingId, resolvePublicReleaseRingIdForLabel, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

type UninstallFlags = Readonly<{
  json: boolean;
  yes: boolean;
  dryRun: boolean;
  keepService: boolean;
  help: boolean;
}>;

type UnsupportedInstallSource = 'fromSource' | 'npmGlobal' | 'pathBinary' | 'unknown';

function usage(): string {
  return [
    `${sectionTitle('happier uninstall')} - Uninstall the current managed Happier CLI`,
    '',
    sectionTitle('Usage:'),
    `  ${cmd('happier uninstall [--yes] [--dry-run] [--keep-service] [--json]')}`,
    '',
  ].join('\n');
}

function parseFlags(args: readonly string[]): UninstallFlags {
  const flags = new Set(args.filter((arg) => arg.startsWith('-')));
  return {
    json: flags.has('--json'),
    yes: flags.has('--yes') || flags.has('-y'),
    dryRun: flags.has('--dry-run'),
    keepService: flags.has('--keep-service'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function resolveInvokerName(): string | null {
  const envInvokerName = basename(String(process.env.HAPPIER_CLI_INVOKER_NAME ?? '').trim())
    .replace(/\.exe$/iu, '')
    .replace(/\.m?js$/iu, '')
    .trim();
  if (envInvokerName) return envInvokerName;
  const candidates = [process.argv[1] ?? '', process.argv[0] ?? ''];
  for (const candidate of candidates) {
    const normalized = basename(String(candidate ?? '').trim())
      .replace(/\.exe$/iu, '')
      .replace(/\.m?js$/iu, '')
      .trim();
    if (normalized) return normalized;
  }
  return null;
}

function resolveManagedCliChannel(ring: string | null | undefined): PublicReleaseRingId {
  return normalizePublicReleaseRingId(String(ring ?? '').trim()) || 'stable';
}

function parseUnsupportedInstallSourceFromInstallationId(installationId: string | null | undefined): UnsupportedInstallSource | null {
  const prefix = String(installationId ?? '').split(':', 1)[0]?.trim() ?? '';
  if (prefix === 'fromSource' || prefix === 'npmGlobal' || prefix === 'pathBinary' || prefix === 'unknown') {
    return prefix;
  }
  return null;
}

function resolveUnsupportedInstallSource(source: string | null | undefined): UnsupportedInstallSource {
  return source === 'npmGlobal' || source === 'fromSource' || source === 'pathBinary'
    ? source
    : 'unknown';
}

function resolveManualUninstallCommandForSource(source: UnsupportedInstallSource): string {
  return source === 'npmGlobal'
    ? 'npm uninstall -g @happier-dev/cli'
    : 'Remove the binary or checkout manually, then run `happier service list --json` to inspect leftover services.';
}

function resolveMatchingDaemonServices(services: readonly HappierService[], installationRoots: readonly string[]): HappierService[] {
  return services.filter((service) => {
    if (service.serviceType !== 'daemon' || service.verification !== 'verified') return false;
    const executablePath = normalizeHappierRuntimePath(service.executablePath);
    if (!executablePath) return false;
    return installationRoots.some((root) => isHappierRuntimePathWithinRoot(executablePath, root));
  });
}

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

export async function handleUninstallCliCommand(context: CommandContext): Promise<void> {
  const flags = parseFlags(context.args.slice(1));
  if (flags.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const envInvokedPath = String(process.env.HAPPIER_CLI_INVOKED_PATH ?? '').trim();
  const invokedPath = envInvokedPath || process.argv[1] || null;
  const installations = await discoverHappierInstallations({
    processEnv: process.env,
    invokedPath,
    invokerName: resolveInvokerName(),
  });
  const activeInstallationId = installations.activeInvocation?.installationId ?? null;
  const activeInstallation = installations.installations.find((entry) => entry.id === activeInstallationId) ?? null;
  if (!activeInstallation) {
    const inferredSource = parseUnsupportedInstallSourceFromInstallationId(activeInstallationId);
    if (inferredSource) {
      const manualCommand = resolveManualUninstallCommandForSource(inferredSource);
      if (flags.json) {
        printJson({
          ok: false,
          error: 'unsupported_install_source',
          source: inferredSource,
          manualCommands: [manualCommand],
        });
        return;
      }
      throw new Error(`Automatic uninstall is only supported for managed Happier CLI installs. Try: ${manualCommand}`);
    }
    if (flags.json) {
      printJson({ ok: false, error: 'active_installation_not_found' });
      return;
    }
    throw new Error('Could not determine the active Happier installation to uninstall.');
  }

  if (activeInstallation.source !== 'firstPartyManaged') {
    const unsupportedSource = resolveUnsupportedInstallSource(activeInstallation.source);
    const manualCommand = resolveManualUninstallCommandForSource(unsupportedSource);
    if (flags.json) {
      printJson({
        ok: false,
        error: 'unsupported_install_source',
        source: unsupportedSource,
        manualCommands: [manualCommand],
      });
      return;
    }
    throw new Error(`Automatic uninstall is only supported for managed Happier CLI installs. Try: ${manualCommand}`);
  }

  const servicesInventory = await discoverHappierServices({ processEnv: process.env });
  const installationRoots = [activeInstallation.path, activeInstallation.realPath].map(normalizeHappierRuntimePath).filter(Boolean);
  const serviceTargets = flags.keepService ? [] : resolveMatchingDaemonServices(servicesInventory.services, installationRoots);
  const channel = resolveManagedCliChannel(activeInstallation.ring);
  const previewOnly = flags.dryRun || !flags.yes;

  if (previewOnly) {
    if (flags.json) {
      printJson({
        ok: true,
        executed: false,
        installation: {
          id: activeInstallation.id,
          source: activeInstallation.source,
          ring: activeInstallation.ring,
          path: activeInstallation.path,
        },
        serviceTargets: serviceTargets.map((service) => ({
          id: service.id,
          label: service.label,
          ring: service.ring,
          instanceId: service.instanceId,
        })),
      });
      return;
    }
    process.stdout.write(`${usage()}\n`);
    process.stdout.write(`${warn(`Would uninstall ${activeInstallation.path}`)}\n`);
    for (const service of serviceTargets) {
      process.stdout.write(`${warn(`Would uninstall service ${service.label}`)}\n`);
    }
    if (!flags.dryRun) {
      process.stdout.write(`Re-run with ${cmd('--yes')} to apply.\n`);
    }
    return;
  }

  for (const service of serviceTargets) {
    await uninstallDaemonService({
      platform: service.platform,
      mode: service.scope === 'system' ? 'system' : 'user',
      channel: service.ring ? resolvePublicReleaseRingIdForLabel(service.ring) ?? undefined : undefined,
      instanceId: service.instanceId ?? undefined,
      runCommands: true,
    });
  }
  const result = await uninstallManagedFirstPartyComponent({
    componentId: 'happier-cli',
    channel,
    processEnv: process.env,
  });

  if (flags.json) {
    printJson({
      ok: true,
      executed: true,
      removedPaths: result.removedPaths,
      serviceTargets: serviceTargets.map((service) => ({ id: service.id, label: service.label })),
    });
    return;
  }
  process.stdout.write(`${ok('Happier CLI uninstalled.')}\n`);
}
