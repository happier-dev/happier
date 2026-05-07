import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

type MetroPatchTestGlobals = {
    __workletsModuleProxy?: {
        propagateModuleUpdate: ReturnType<typeof vi.fn>;
    };
    globalEvalWithSourceUrl?: ReturnType<typeof vi.fn>;
    __hmrEvalCount?: number;
    WebSocket?: typeof WebSocket;
};

function getMetroPatchTestGlobals(): typeof globalThis & MetroPatchTestGlobals {
    return globalThis as typeof globalThis & MetroPatchTestGlobals;
}

function getRepoRoot(): string {
    return join(__dirname, '..', '..', '..', '..', '..');
}

function createTempFixtureDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function writeFixtureFiles(rootDir: string, files: Record<string, string>): void {
    for (const [relativePath, contents] of Object.entries(files)) {
        const absolutePath = join(rootDir, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, contents);
    }
}

function applyPatch(rootDir: string, patchRelativePath: string): void {
    const result = spawnSync(
        'git',
        ['apply', '--unsafe-paths', join(getRepoRoot(), patchRelativePath)],
        {
            cwd: rootDir,
            encoding: 'utf8',
        },
    );

    if (result.status !== 0) {
        throw new Error(`Failed to apply ${patchRelativePath}: ${result.stderr || result.stdout}`);
    }
}

function applyPatchPackage(rootDir: string, patchContentsByFile: Record<string, string>): void {
    const patchDir = join(rootDir, 'patches');
    mkdirSync(patchDir, { recursive: true });
    for (const [fileName, contents] of Object.entries(patchContentsByFile)) {
        writeFileSync(join(patchDir, fileName), contents);
    }

    const result = spawnSync(
        process.execPath,
        [require.resolve('patch-package/dist/index.js'), '--patch-dir', 'patches'],
        {
            cwd: rootDir,
            encoding: 'utf8',
        },
    );

    if (result.status !== 0) {
        throw new Error(`patch-package failed: ${result.stderr || result.stdout}`);
    }
}

describe('apps/ui patch-package Metro worklets patches', () => {
    const fixtureDirs: string[] = [];

    afterEach(() => {
        const testGlobals = getMetroPatchTestGlobals();
        while (fixtureDirs.length > 0) {
            const fixtureDir = fixtureDirs.pop();
            if (fixtureDir) {
                rmSync(fixtureDir, { recursive: true, force: true });
            }
        }
        vi.restoreAllMocks();
        Reflect.deleteProperty(testGlobals, '__workletsModuleProxy');
        Reflect.deleteProperty(testGlobals, 'globalEvalWithSourceUrl');
        Reflect.deleteProperty(testGlobals, 'WebSocket');
        Reflect.deleteProperty(testGlobals, '__hmrEvalCount');
    });

    it('hashes generated worklet files from both supported layouts using stable file content', () => {
        const patchContents = readFileSync(
            join(getRepoRoot(), 'apps/ui/patches/metro+0.83.3.patch'),
            'utf8',
        );

        expect(patchContents).toContain('react-native-worklets/.worklets/');
        expect(patchContents).toContain('react-native-worklets/__generatedWorklets/');
        expect(patchContents).not.toContain('performance.now()');
        expect(patchContents).toMatch(/readFileSync|promises\.readFile|fs\.readFileSync/u);
        expect(patchContents).toContain('createHash("sha1")');
    });

    it('applies the Metro worklets hash patch through patch-package', () => {
        const fixtureDir = createTempFixtureDir('happier-ui-metro-patch-package-');
        fixtureDirs.push(fixtureDir);

        writeFixtureFiles(fixtureDir, {
            'package.json': JSON.stringify({
                dependencies: {
                    metro: '0.83.3',
                },
            }),
            'node_modules/metro/package.json': JSON.stringify({
                name: 'metro',
                version: '0.83.3',
            }),
            'node_modules/metro/src/node-haste/DependencyGraph.js': `${Array.from({ length: 185 }, (_, index) => `// fixture padding ${index + 1}`).join('\n')}
    return (0, _nullthrows.default)(this._fileSystem).getAllFiles();
  }
  async getOrComputeSha1(mixedPath) {
    const result = await this._fileSystem.getOrComputeSha1(mixedPath);
    if (!result || !result.sha1) {
      throw new Error(\`Failed to get the SHA-1 for: \${mixedPath}.
      Potential causes:
        1) The file is not watched. Ensure it is under the configured \`projectRoot\` or \`watchFolders\`.
        2) Check \`blockList\` in your metro.config.js and make sure it isn't excluding the file path.
        3) The file may have been deleted since it was resolved - try refreshing your app.
        4) Otherwise, this is a bug in Metro or the configured resolver - please report it.\`);
    }
    return result;
  }
`,
        });

        applyPatchPackage(fixtureDir, {
            'metro+0.83.3.patch': readFileSync(
                join(getRepoRoot(), 'apps/ui/patches/metro+0.83.3.patch'),
                'utf8',
            ),
        });

        expect(readFileSync(
            join(fixtureDir, 'node_modules/metro/src/node-haste/DependencyGraph.js'),
            'utf8',
        )).toEqual(expect.stringContaining('react-native-worklets/.worklets/'));
        expect(readFileSync(
            join(fixtureDir, 'node_modules/metro/src/node-haste/DependencyGraph.js'),
            'utf8',
        )).toEqual(expect.stringContaining('react-native-worklets/__generatedWorklets/'));
    });

    it('continues normal HMR eval when the worklets update hook throws', () => {
        const fixtureDir = createTempFixtureDir('happier-ui-metro-runtime-patch-');
        fixtureDirs.push(fixtureDir);

        writeFixtureFiles(fixtureDir, {
            'node_modules/metro-runtime/src/modules/HMRClient.js': `"use strict";

const EventEmitter = require("./vendor/eventemitter3");
const inject = ({ module: [id, code], sourceURL }) => {
  if (global.globalEvalWithSourceUrl) {
    global.globalEvalWithSourceUrl(code, sourceURL);
  } else {
    eval(code);
  }
};
const injectUpdate = (update) => {
  update.added.forEach(inject);
  update.modified.forEach(inject);
};
class HMRClient extends EventEmitter {
  _isEnabled = false;
  _pendingUpdate = null;
  _queue = [];
  _state = "opening";
  constructor(url) {
    super();
    this._ws = new global.WebSocket(url);
    this._ws.onopen = () => {
      this._state = "open";
      this.emit("open");
      this._flushQueue();
    };
    this._ws.onerror = (error) => {
      this.emit("connection-error", error);
    };
    this._ws.onclose = (closeEvent) => {
      this._state = "closed";
      this.emit("close", closeEvent);
    };
    this._ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data));
      switch (data.type) {
        case "bundle-registered":
          this.emit("bundle-registered");
          break;
        case "update-start":
          this.emit("update-start", data.body);
          break;
        case "update":
          this.emit("update", data.body);
          break;
        case "update-done":
          this.emit("update-done");
          break;
        case "error":
          this.emit("error", data.body);
          break;
        default:
          this.emit("error", {
            type: "unknown-message",
            message: data,
          });
      }
    };
    this.on("update", (update) => {
      if (this._isEnabled) {
        injectUpdate(update);
      } else if (this._pendingUpdate == null) {
        this._pendingUpdate = update;
      } else {
        this._pendingUpdate = update;
      }
    });
  }
  close() {
    this._ws.close();
  }
  send(message) {
    switch (this._state) {
      case "opening":
        this._queue.push(message);
        break;
      case "open":
        this._ws.send(message);
        break;
      case "closed":
        break;
      default:
        throw new Error("[WebSocketHMRClient] Unknown state: " + this._state);
    }
  }
  _flushQueue() {
    this._queue.forEach((message) => this.send(message));
    this._queue.length = 0;
  }
  enable() {
    this._isEnabled = true;
    const update = this._pendingUpdate;
    this._pendingUpdate = null;
    if (update != null) {
      injectUpdate(update);
    }
  }
  disable() {
    this._isEnabled = false;
  }
  isEnabled() {
    return this._isEnabled;
  }
  hasPendingUpdates() {
    return this._pendingUpdate != null;
  }
}
module.exports = HMRClient;
`,
            'node_modules/metro-runtime/src/modules/vendor/eventemitter3.js': `module.exports = class EventEmitter {
  constructor() {
    this.listeners = new Map();
  }
  on(eventName, handler) {
    const existing = this.listeners.get(eventName) || [];
    existing.push(handler);
    this.listeners.set(eventName, existing);
  }
  emit(eventName, ...args) {
    for (const handler of this.listeners.get(eventName) || []) {
      handler(...args);
    }
  }
};
`,
        });

        applyPatch(fixtureDir, 'apps/ui/patches/metro-runtime+0.83.3.patch');

        const hmrClientModulePath = join(
            fixtureDir,
            'node_modules/metro-runtime/src/modules/HMRClient.js',
        );
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const HMRClient = require(hmrClientModulePath) as new (url: string) => {
            _ws: { onmessage: (message: { data: string }) => void };
            enable(): void;
        };

        const testGlobals = getMetroPatchTestGlobals();
        testGlobals.WebSocket = class {
            onopen?: () => void;
            onerror?: (error: unknown) => void;
            onclose?: (event: unknown) => void;
            onmessage?: (message: { data: string }) => void;

            constructor(_url: string) {}

            close() {}

            send(_message: string) {}
        } as unknown as typeof WebSocket;
        testGlobals.__workletsModuleProxy = {
            propagateModuleUpdate: vi.fn(() => {
                throw new Error('worklets hook failed');
            }),
        };
        testGlobals.globalEvalWithSourceUrl = vi.fn(() => {
            testGlobals.__hmrEvalCount = (testGlobals.__hmrEvalCount ?? 0) + 1;
        });

        const client = new HMRClient('ws://localhost:19000');
        client.enable();

        expect(() => {
            client._ws.onmessage({
                data: JSON.stringify({
                    type: 'update',
                    body: {
                        added: [],
                        modified: [
                            {
                                module: [1, 'globalThis.__hmrEvalCount = 999;', {}],
                                sourceURL: 'http://localhost:8081/index.bundle?platform=web',
                            },
                        ],
                        deleted: [],
                    },
                }),
            });
        }).not.toThrow();

        expect(testGlobals.__workletsModuleProxy?.propagateModuleUpdate).toHaveBeenCalledTimes(1);
        expect(testGlobals.globalEvalWithSourceUrl).toHaveBeenCalledTimes(1);
        expect(testGlobals.__hmrEvalCount).toBe(1);
    });
});
