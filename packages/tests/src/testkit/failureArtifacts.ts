import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Producer<T> = () => T | Promise<T>;

type Artifact =
  | { kind: 'json'; name: string; produce: Producer<unknown> }
  | { kind: 'text'; name: string; produce: Producer<string> };

export class FailureArtifacts {
  private artifacts: Artifact[] = [];

  json(name: string, produce: Producer<unknown>): void {
    this.artifacts.push({ kind: 'json', name, produce });
  }

  text(name: string, produce: Producer<string>): void {
    this.artifacts.push({ kind: 'text', name, produce });
  }

  async dumpAll(testDir: string, opts?: { onlyIf?: boolean }): Promise<void> {
    if (opts?.onlyIf === false) return;
    await Promise.all(this.artifacts.map(async (artifact) => {
      const path = resolve(testDir, artifact.name);
      try {
        if (artifact.kind === 'json') {
          const value = await artifact.produce();
          writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        } else {
          const text = await artifact.produce();
          writeFileSync(path, text, 'utf8');
        }
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        writeFileSync(path, `FAILED_TO_WRITE_ARTIFACT: ${msg}\n`, 'utf8');
      }
    }));
  }
}
