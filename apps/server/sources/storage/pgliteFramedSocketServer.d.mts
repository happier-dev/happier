import type { PGlite } from '@electric-sql/pglite';

export declare class FramedPgliteSocketServer {
    constructor(options: { db: PGlite; host: string; port: number });
    start(): Promise<void>;
    getServerConn(): string;
    stop(): Promise<void>;
}
