import { join } from 'node:path';

export function brokerAddress(root) {
  return join(root, 'broker.sock');
}

export function slotPrefix(root) { return join(root, 'slot-'); }

export function slotAddress(root, pid, floorKiB, nonce, cpuCores, pressureExempt = false) {
  // Preserve the UUID's 128 bits while keeping the pathname within Linux's
  // sun_path for the canonical admission root, independently of workspace paths.
  const id = Buffer.from(nonce.replaceAll('-', ''), 'hex').toString('base64url');
  // A leading zero records the exception without changing the numeric CPU
  // charge seen by an incumbent reader during rollback.
  const charge = cpuCores === undefined ? '' : `-${pressureExempt ? '0' : ''}${cpuCores.toString(36)}`;
  return `${slotPrefix(root)}${pid.toString(36)}-${floorKiB.toString(36)}-${id}${charge}`;
}

export function readSlotAddress(root, name) {
  const match = /^slot-([0-9a-z]+)-([0-9a-z]+)-[A-Za-z0-9_-]{22}(?:-([0-9a-z]+))?$/.exec(name);
  return match ? { address: join(root, name), pid: Number.parseInt(match[1], 36),
    floorKiB: Number.parseInt(match[2], 36),
    ...(match[3] ? { cpuCores: Number.parseInt(match[3], 36) } : {}),
    ...(match[3]?.length > 1 && match[3].startsWith('0') ? { pressureExempt: true } : {}) } : null;
}
