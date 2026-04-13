import { posix } from 'node:path';

export function resolveDaemonLegacySessionScopeSubtreeRelativePath(daemonServiceRelativePath: string): string | null {
  const daemonServicePath = daemonServiceRelativePath.trim();
  if (!daemonServicePath) {
    return null;
  }

  const serviceParentRelativePath = posix.dirname(daemonServicePath);
  if (!serviceParentRelativePath || serviceParentRelativePath === '.' || serviceParentRelativePath === daemonServicePath) {
    return null;
  }

  return serviceParentRelativePath;
}

export function resolveDaemonSessionScopeBaseRelativePath(daemonServiceRelativePath: string): string | null {
  const serviceParentRelativePath = resolveDaemonLegacySessionScopeSubtreeRelativePath(daemonServiceRelativePath);
  if (!serviceParentRelativePath) {
    return null;
  }

  return posix.basename(serviceParentRelativePath) === 'app.slice'
    ? posix.dirname(serviceParentRelativePath)
    : serviceParentRelativePath;
}
