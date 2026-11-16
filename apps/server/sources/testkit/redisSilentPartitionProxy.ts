import { createServer, createConnection, type Socket } from "node:net";

type SilentPartitionProxy = Readonly<{
    url: string;
    partition(): void;
    heal(): void;
    /** A loud outage: drop every connection and refuse new ones (ECONNREFUSED) until `accept()`. */
    refuse(): Promise<void>;
    accept(): Promise<void>;
    waitForForwardedCommand(command: string): Promise<void>;
    close(): Promise<void>;
}>;

export async function startSilentPartitionProxy(upstreamUrl: string): Promise<SilentPartitionProxy> {
    const upstream = new URL(upstreamUrl);
    const upstreamPort = Number(upstream.port || "6379");
    let partitioned = false;
    const downstreamSockets = new Set<Socket>();
    const upstreamSockets = new Set<Socket>();
    const forwardedCommands = new Set<string>();
    const commandWaiters = new Map<string, Set<() => void>>();

    const markForwardedCommand = (chunk: Buffer): void => {
        const text = chunk.toString("utf8").toLowerCase();
        for (const command of ["xread", "ping"]) {
            if (!text.includes(command)) continue;
            forwardedCommands.add(command);
            for (const resolve of commandWaiters.get(command) ?? []) resolve();
            commandWaiters.delete(command);
        }
    };

    const server = createServer((downstream) => {
        downstreamSockets.add(downstream);
        if (partitioned) {
            downstream.destroy();
            return;
        }
        const redis = createConnection({
            host: upstream.hostname,
            port: upstreamPort,
        });
        upstreamSockets.add(redis);
        downstream.on("data", (chunk: Buffer) => {
            if (partitioned || !redis.writable) return;
            markForwardedCommand(chunk);
            redis.write(chunk);
        });
        redis.on("data", (chunk: Buffer) => {
            if (!partitioned && downstream.writable) downstream.write(chunk);
        });
        downstream.on("close", () => {
            downstreamSockets.delete(downstream);
            redis.destroy();
        });
        redis.on("close", () => {
            upstreamSockets.delete(redis);
            downstream.destroy();
        });
        downstream.on("error", () => {});
        redis.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Silent partition proxy did not expose a TCP port");
    }

    const proxyUrl = new URL(upstreamUrl);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(address.port);
    return {
        url: proxyUrl.toString(),
        partition: () => {
            partitioned = true;
        },
        heal: () => {
            partitioned = false;
        },
        refuse: async () => {
            const closed = new Promise<void>((resolve) => server.close(() => resolve()));
            for (const socket of downstreamSockets) socket.destroy();
            for (const socket of upstreamSockets) socket.destroy();
            await closed;
        },
        accept: async () => {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(address.port, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
        },
        waitForForwardedCommand: async (command) => {
            const normalized = command.toLowerCase();
            if (forwardedCommands.has(normalized)) return;
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(
                    new Error(`Timed out waiting for ${normalized} through silent partition proxy`),
                ), 2_000);
                const waiter = () => {
                    clearTimeout(timeout);
                    resolve();
                };
                const waiters = commandWaiters.get(normalized) ?? new Set();
                waiters.add(waiter);
                commandWaiters.set(normalized, waiters);
            });
        },
        close: async () => {
            for (const socket of downstreamSockets) socket.destroy();
            for (const socket of upstreamSockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

