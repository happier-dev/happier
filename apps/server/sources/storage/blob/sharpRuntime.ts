import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type sharp from "sharp";

type SharpFactory = typeof sharp;

function normalizeSharpModule(value: unknown): SharpFactory {
    const candidate = value && typeof value === "object" && "default" in value
        ? value.default
        : value;
    if (typeof candidate !== "function") {
        throw new Error("The sharp runtime module did not export a factory function");
    }
    return candidate as SharpFactory;
}

export function resolveSharpModule(params: Readonly<{
    moduleUrl: string;
    executablePath: string;
}>): SharpFactory {
    const packageName = "sharp";
    try {
        return normalizeSharpModule(createRequire(params.moduleUrl)(packageName));
    } catch (moduleResolutionError) {
        try {
            const sidecarRequire = createRequire(join(dirname(params.executablePath), "package.json"));
            return normalizeSharpModule(sidecarRequire(packageName));
        } catch (sidecarResolutionError) {
            throw new AggregateError(
                [moduleResolutionError, sidecarResolutionError],
                "Unable to load sharp from the bundled module graph or executable sidecars",
            );
        }
    }
}

let sharpPromise: Promise<SharpFactory> | null = null;

export async function loadSharp(): Promise<SharpFactory> {
    sharpPromise ??= Promise.resolve().then(() => resolveSharpModule({
        moduleUrl: import.meta.url,
        executablePath: process.execPath,
    }));
    return await sharpPromise;
}
