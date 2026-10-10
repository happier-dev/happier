// Process IO is a genuine system boundary. An authenticated saved-editor startup
// must not invoke Home's unrelated local CLI acquisition graph in this browser.
export function spawn(): never {
    throw new Error('Saved-workflow browser startup attempted local process IO');
}
export const execFile = spawn;
export const spawnSync = spawn;
export const execFileSync = spawn;
