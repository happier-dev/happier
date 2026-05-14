function unavailableNodeBuiltin(): never {
  throw new Error('Node builtin modules are not available in the native UI runtime.');
}

export const constants = {};
export const promises = {};

export const exec = unavailableNodeBuiltin;
export const execFile = unavailableNodeBuiltin;
export const fork = unavailableNodeBuiltin;
export const spawn = unavailableNodeBuiltin;
export const spawnSync = unavailableNodeBuiltin;

export default {};
