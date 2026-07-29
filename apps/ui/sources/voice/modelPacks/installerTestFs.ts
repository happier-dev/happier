/**
 * Test-only in-memory filesystem that models a real directory tree for the
 * native model-pack installer specs. Unlike a flat uri->bytes map, it supports
 * `Directory.move` (relocating an entire subtree) and `Directory.delete`
 * (removing only that subtree), which the atomic staging -> backup -> swap
 * install flow relies on.
 *
 * Boundary mock only: it stands in for `expo-file-system`'s `Directory`/`File`
 * API. Domain installer logic is exercised for real.
 */
export type MemFs = {
  fs: { Directory: any; File: any; Paths: { document: string } };
  files: Map<string, Uint8Array>;
  root: string;
};

export function createMemFs(): MemFs {
  const files = new Map<string, Uint8Array>();
  const root = 'file:///docs/happier/voice/modelPacks';

  const normalize = (uri: string): string => uri.replace(/\/+$/, '');
  const joinUri = (base: string, name: string): string => `${normalize(base)}/${name}`;

  function resolveUri(args: any[]): string {
    if (args.length === 0) return root;
    const [first, ...rest] = args;
    let base: string;
    if (first && typeof first === 'object' && typeof first.uri === 'string') {
      base = normalize(first.uri);
    } else if (typeof first === 'string') {
      base = normalize(first);
    } else {
      base = root;
    }
    for (const segment of rest) {
      base = joinUri(base, String(segment));
    }
    return base;
  }

  class Directory {
    uri: string;
    constructor(...args: any[]) {
      this.uri = resolveUri(args);
    }
    get exists(): boolean {
      const prefix = `${this.uri}/`;
      for (const key of files.keys()) {
        if (key === this.uri || key.startsWith(prefix)) return true;
      }
      return false;
    }
    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    create() {
      // Directories are implicit (defined by the files they contain).
    }
    delete() {
      const prefix = `${this.uri}/`;
      for (const key of Array.from(files.keys())) {
        if (key === this.uri || key.startsWith(prefix)) files.delete(key);
      }
    }
    move(destination: { uri: string }) {
      const prefix = `${this.uri}/`;
      const destUri = normalize(destination.uri);
      for (const key of Array.from(files.keys())) {
        if (key.startsWith(prefix)) {
          const suffix = key.slice(this.uri.length);
          const value = files.get(key)!;
          files.delete(key);
          files.set(`${destUri}${suffix}`, value);
        } else if (key === this.uri) {
          const value = files.get(key)!;
          files.delete(key);
          files.set(destUri, value);
        }
      }
      this.uri = destUri;
    }
    list() {
      const prefix = `${this.uri}/`;
      const children = new Map<string, boolean>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const remainder = key.slice(prefix.length);
        const [name, ...rest] = remainder.split('/');
        if (!name) continue;
        children.set(name, (children.get(name) ?? false) || rest.length > 0);
      }
      return [...children.entries()].map(([name, isDirectory]) => (
        isDirectory ? new Directory(this, name) : new File(this, name)
      ));
    }
  }

  class File {
    uri: string;
    constructor(...args: any[]) {
      this.uri = resolveUri(args);
    }
    get exists(): boolean {
      return files.has(this.uri);
    }
    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get size(): number {
      return files.get(this.uri)?.byteLength ?? 0;
    }
    create() {
      if (!files.has(this.uri)) files.set(this.uri, new Uint8Array());
    }
    write(data: string | Uint8Array, options?: { append?: boolean }) {
      const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (options?.append) {
        const prior = files.get(this.uri) ?? new Uint8Array();
        const out = new Uint8Array(prior.byteLength + buf.byteLength);
        out.set(prior, 0);
        out.set(buf, prior.byteLength);
        files.set(this.uri, out);
        return;
      }
      files.set(this.uri, new Uint8Array(buf));
    }
    writableStream() {
      const uri = this.uri;
      let acc: Uint8Array[] = [];
      return new WritableStream<Uint8Array>({
        write(chunk: Uint8Array) {
          acc.push(new Uint8Array(chunk));
        },
        close() {
          const total = acc.reduce((sum, b) => sum + b.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const b of acc) {
            out.set(b, off);
            off += b.length;
          }
          files.set(uri, out);
          acc = [];
        },
      });
    }
    async bytes(): Promise<Uint8Array> {
      return files.get(this.uri) ?? new Uint8Array();
    }
    readableStream() {
      const bytes = files.get(this.uri) ?? new Uint8Array();
      let delivered = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered) {
            controller.close();
            return;
          }
          delivered = true;
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
    async text(): Promise<string> {
      return new TextDecoder().decode(files.get(this.uri) ?? new Uint8Array());
    }
    delete() {
      files.delete(this.uri);
    }
    arrayBuffer(): Promise<ArrayBuffer> {
      return this.bytes().then((b) => b.buffer as ArrayBuffer);
    }
  }

  const fs = { Directory, File, Paths: { document: 'file:///docs/' } };
  return { fs, files, root };
}
