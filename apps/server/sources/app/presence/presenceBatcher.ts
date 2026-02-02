type SessionPresence = { sessionId: string; timestamp: number };
type MachinePresence = { accountId: string; machineId: string; timestamp: number };

export class PresenceBatcher {
    private sessionById = new Map<string, SessionPresence>();
    private machineByKey = new Map<string, MachinePresence>();

    recordSessionAlive(sessionId: string, timestamp: number): void {
        const existing = this.sessionById.get(sessionId);
        if (!existing || timestamp > existing.timestamp) {
            this.sessionById.set(sessionId, { sessionId, timestamp });
        }
    }

    recordMachineAlive(accountId: string, machineId: string, timestamp: number): void {
        const key = `${accountId}:${machineId}`;
        const existing = this.machineByKey.get(key);
        if (!existing || timestamp > existing.timestamp) {
            this.machineByKey.set(key, { accountId, machineId, timestamp });
        }
    }

    snapshot(): { sessions: SessionPresence[]; machines: MachinePresence[] } {
        const sessions = Array.from(this.sessionById.values());
        const machines = Array.from(this.machineByKey.values());
        return { sessions, machines };
    }

    commit(snapshot: { sessions: SessionPresence[]; machines: MachinePresence[] }): void {
        // Remove only entries that have not been superseded since the snapshot.
        for (const s of snapshot.sessions) {
            const current = this.sessionById.get(s.sessionId);
            if (current && current.timestamp <= s.timestamp) {
                this.sessionById.delete(s.sessionId);
            }
        }
        for (const m of snapshot.machines) {
            const key = `${m.accountId}:${m.machineId}`;
            const current = this.machineByKey.get(key);
            if (current && current.timestamp <= m.timestamp) {
                this.machineByKey.delete(key);
            }
        }
    }

    drain(): { sessions: SessionPresence[]; machines: MachinePresence[] } {
        const { sessions, machines } = this.snapshot();
        this.sessionById.clear();
        this.machineByKey.clear();
        return { sessions, machines };
    }
}
