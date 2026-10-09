import type { App, Image, ModalClient, SandboxCreateParams } from 'modal';

/** Private in-process IO handle; never a serialized Action result. */
export interface ModalPrivateProcessHandle {
  wait(): Promise<number>;
  readonly stdin: { writeBytes(data: Uint8Array): Promise<void>; close(): Promise<void> };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

export interface ModalSandboxHandle {
  readonly sandboxId: string;
  poll(): Promise<number | null>;
  terminate(): Promise<void>;
  exec(argv: string[], options: { stdout: 'ignore' | 'pipe'; stderr: 'ignore' | 'pipe'; mode: 'binary'; timeoutMs?: number }): Promise<ModalPrivateProcessHandle>;
  readonly filesystem: { writeBytes(data: Uint8Array, remotePath: string): Promise<void> };
}

/** The vendor SDK/network boundary. Native identity and lifecycle decisions remain in the leaf. */
export interface ModalNativeClient {
  version(): string;
  readonly apps: Pick<ModalClient['apps'], 'fromName'>;
  readonly images: Pick<ModalClient['images'], 'fromRegistry'>;
  readonly sandboxes: {
    create(app: App, image: Image, input: SandboxCreateParams): Promise<ModalSandboxHandle>;
    fromId(sandboxId: string): Promise<ModalSandboxHandle>;
    list(input?: { appId?: string; tags?: Record<string, string> }): AsyncIterable<ModalSandboxHandle>;
  };
}
