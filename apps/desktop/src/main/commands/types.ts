import type { BrowserWindow, WebContents } from 'electron';

export type CommandArgs = Readonly<Record<string, unknown>>;

export type CommandContext = Readonly<{
    /** The window the invoke came from, or `null` if it was destroyed mid-flight. */
    window: BrowserWindow | null;
    sender: WebContents;
    /** Emits a host event to every renderer listening for `name`, mirroring Tauri's event plugin. */
    emitEvent: (name: string, payload: unknown) => void;
    /** Delivers a payload to one callback the calling renderer registered via `transformCallback`. */
    sendCallback: (callbackId: number, payload: unknown) => void;
}>;

export type CommandHandler = (args: CommandArgs, context: CommandContext) => Promise<unknown> | unknown;

export type CommandRegistry = ReadonlyMap<string, CommandHandler>;
