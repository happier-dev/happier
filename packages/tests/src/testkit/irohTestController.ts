import type { IrohObservedPath, IrohRelayPolicy } from '@happier-dev/iroh-native';

export type IrohForcedPath = 'direct' | 'relay';

/** Test-only controller used by forced-direct/forced-relay native fixtures. */
export class IrohTestController {
  private forcedPath: IrohForcedPath | null = null;
  private currentPath: IrohObservedPath = 'unknown';
  readonly policy: IrohRelayPolicy;

  constructor(options: Readonly<{ policy?: IrohRelayPolicy; observedPath?: IrohObservedPath }> = {}) {
    this.policy = options.policy ?? 'automatic';
    this.currentPath = options.observedPath ?? 'unknown';
  }

  forceDirectOnly(): void { this.forcedPath = 'direct'; this.currentPath = 'direct'; }

  forceRelayOnly(): void {
    if (this.policy === 'disabled') throw new Error('Cannot force relay while Iroh relay policy is disabled');
    this.forcedPath = 'relay';
    this.currentPath = 'relay';
  }

  restoreAutomatic(): void { this.forcedPath = null; this.currentPath = 'unknown'; }

  getObservedPath(): IrohObservedPath { return this.currentPath; }

  assertForcedPath(expected: IrohForcedPath): void {
    if (this.forcedPath !== expected || this.currentPath !== expected) {
      throw new Error(`Expected forced ${expected} path, observed ${this.currentPath}`);
    }
  }
}

export function createIrohTestController(options: Readonly<{ policy?: IrohRelayPolicy; observedPath?: IrohObservedPath }> = {}): IrohTestController {
  return new IrohTestController(options);
}
