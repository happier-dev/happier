import { join } from 'node:path';

export function brokerAddress(root) {
  return join(root, 'broker.sock');
}

export function slotPrefix(root) { return join(root, 'slot-'); }

export function slotAddress(root, pid, floorKiB, nonce, cpuCores) {
  // Preserve the UUID's 128 bits while keeping the pathname within Linux's
  // sun_path for the canonical admission root, independently of workspace paths.
  const id = Buffer.from(nonce.replaceAll('-', ''), 'hex').toString('base64url');
  return `${slotPrefix(root)}${pid.toString(36)}-${floorKiB.toString(36)}-${id}${cpuCores === undefined ? '' : '-' + cpuCores.toString(36)}`;
}

export function readSlotAddress(root, name) {
  const match = /^slot-([0-9a-z]+)-([0-9a-z]+)-[A-Za-z0-9_-]{22}(?:-([0-9a-z]+))?$/.exec(name);
  return match ? { address: join(root, name), pid: Number.parseInt(match[1], 36),
    floorKiB: Number.parseInt(match[2], 36),
    ...(match[3] ? { cpuCores: Number.parseInt(match[3], 36) } : {}) } : null;
}
