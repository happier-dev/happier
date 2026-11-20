/** @moduleRealm any */
import type { MachineProvisionerCheckResultV1 } from '../machineProvisioners.js';

/** Keep provider labels local while sharing the status projection. */
export function createMachineProvisionerCheckPresenter(
  labels: Readonly<Record<string, string>> & Readonly<{ ready: string; unavailable: string }>,
  keyPrefix: string,
): (result: MachineProvisionerCheckResultV1) => MachineProvisionerCheckResultV1 {
  return result => {
    if (result.status !== undefined) return result;
    const code = result.code;
    const defaultId = result.available ? 'ready' : 'unavailable';
    const id = code && Object.hasOwn(labels, code) ? code : defaultId;
    return { ...result, status: { key: keyPrefix + id, fallback: labels[id] ?? labels[defaultId] } };
  };
}
