import { describe, expect, it } from "vitest";

import { countPhysicalCpus } from "./prismaDriverAdapters";

const processor = (physical: number, core: number) => `processor\t: 0\nphysical id\t: ${physical}\ncore id\t\t: ${core}\nflags\t\t: fpu\n`;

describe("PostgreSQL/MySQL pool default", () => {
    it("counts physical cores the way the Rust engine sized its default pool", () => {
        // Two sockets, two cores each, two hyperthreads per core: 8 logical, 4 physical.
        const cpuInfo = [processor(0, 0), processor(0, 0), processor(0, 1), processor(0, 1),
            processor(1, 0), processor(1, 0), processor(1, 1), processor(1, 1)].join("\n");
        expect(countPhysicalCpus(cpuInfo, 8)).toBe(4);
    });

    it("falls back to the logical count where no core topology is reported", () => {
        expect(countPhysicalCpus(null, 6)).toBe(6);
        expect(countPhysicalCpus("processor\t: 0\nBogoMIPS\t: 50.00\n", 2)).toBe(2);
    });
});
