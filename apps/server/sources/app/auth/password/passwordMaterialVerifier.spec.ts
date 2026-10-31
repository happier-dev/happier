import { describe, expect, it } from 'vitest';
import {
    acceptPasswordTextV1,
    PASSWORD_SCRYPT_MAX_COST_V1,
    type PasswordMaterialHashV1,
} from '@happier-dev/protocol';
import {
    createPasswordHashAdmission,
    PasswordHashOverloadedError,
    resolveLibuvThreadpoolSize,
} from './passwordHashAdmission';
import {
    hashPasswordMaterial,
    passwordHashAdmission,
    performDummyPasswordWork,
    verifyPasswordMaterial,
    PASSWORD_HASH_WRITER_PARAMETERS_V1,
} from './passwordMaterialVerifier';

function utf8(password: string): Uint8Array {
    const accepted = acceptPasswordTextV1(password);
    if (!accepted.accepted) throw new Error(`test password rejected: ${accepted.reason}`);
    return accepted.utf8;
}

const PASSWORD = 'correct horse battery staple';

describe('password material verifier', () => {
    it('round-trips the Plain branch and rejects a different password', async () => {
        const hash = await hashPasswordMaterial(utf8(PASSWORD));
        expect(hash.algorithm).toBe('scrypt');
        expect(hash.parameters).toEqual(PASSWORD_HASH_WRITER_PARAMETERS_V1);
        await expect(verifyPasswordMaterial(hash, utf8(PASSWORD))).resolves.toBe(true);
        await expect(verifyPasswordMaterial(hash, utf8(`${PASSWORD}!`))).resolves.toBe(false);
    });

    it('verifies raw derived key bytes through the same primitive as password text', async () => {
        // The E2EE branch supplies an already-derived 32-byte authKey. One
        // module must serve both or the two credential kinds drift apart.
        const authKey = new Uint8Array(32).fill(11);
        const hash = await hashPasswordMaterial(authKey);
        await expect(verifyPasswordMaterial(hash, authKey)).resolves.toBe(true);
        const nearMiss = new Uint8Array(32).fill(11);
        nearMiss[31] = 12;
        await expect(verifyPasswordMaterial(hash, nearMiss)).resolves.toBe(false);
    });

    it('salts every record so equal passwords do not produce equal digests', async () => {
        const first = await hashPasswordMaterial(utf8(PASSWORD));
        const second = await hashPasswordMaterial(utf8(PASSWORD));
        expect(first.salt).not.toBe(second.salt);
        expect(first.digest).not.toBe(second.digest);
        await expect(verifyPasswordMaterial(second, utf8(PASSWORD))).resolves.toBe(true);
    });

    it('treats byte-distinct passwords the acceptance policy preserved as distinct', async () => {
        // Precomposed U+00E9 versus e + U+0301. Any normalization anywhere in
        // this path would make these verify against each other.
        const precomposed = 'café password one';
        const decomposed = 'café password one';
        expect(precomposed).not.toBe(decomposed);
        const hash = await hashPasswordMaterial(utf8(precomposed));
        await expect(verifyPasswordMaterial(hash, utf8(decomposed))).resolves.toBe(false);
        await expect(verifyPasswordMaterial(hash, utf8(precomposed))).resolves.toBe(true);
    });

    it('fails closed on a record outside the accepted ladder instead of allocating', async () => {
        const hash = await hashPasswordMaterial(utf8(PASSWORD));
        const hostile: PasswordMaterialHashV1 = {
            ...hash,
            parameters: { ...hash.parameters, n: PASSWORD_SCRYPT_MAX_COST_V1 * 64 },
        };
        await expect(verifyPasswordMaterial(hostile, utf8(PASSWORD))).resolves.toBe(false);
        await expect(verifyPasswordMaterial({ nonsense: true }, utf8(PASSWORD))).resolves.toBe(false);
        await expect(verifyPasswordMaterial(null, utf8(PASSWORD))).resolves.toBe(false);
    });

    it('spends comparable work on dummy verification as on a real failure', async () => {
        const hash = await hashPasswordMaterial(utf8(PASSWORD));
        const startedReal = performance.now();
        await verifyPasswordMaterial(hash, utf8(`${PASSWORD} wrong`));
        const realMs = performance.now() - startedReal;

        const startedDummy = performance.now();
        await performDummyPasswordWork();
        const dummyMs = performance.now() - startedDummy;

        // A shared loaded host makes exact timing meaningless, so assert the
        // property that matters: the unknown-Account path is the same order of
        // magnitude, not the microseconds an early return would take.
        expect(dummyMs).toBeGreaterThan(realMs / 10);
        expect(dummyMs).toBeLessThan(realMs * 10);
    });
});

describe('password hash admission', () => {
    it('defaults its concurrency to the libuv threadpool that actually runs scrypt', () => {
        expect(createPasswordHashAdmission().maxConcurrent).toBe(resolveLibuvThreadpoolSize());
        expect(resolveLibuvThreadpoolSize({ UV_THREADPOOL_SIZE: '12' })).toBe(12);
        expect(resolveLibuvThreadpoolSize({ UV_THREADPOOL_SIZE: 'nonsense' })).toBe(4);
        expect(resolveLibuvThreadpoolSize({})).toBe(4);
    });

    it('never runs more than the bound concurrently', async () => {
        const admission = createPasswordHashAdmission({ maxConcurrent: 2, maxQueued: 10 });
        let active = 0;
        let peak = 0;
        const runs = Array.from({ length: 6 }, () => admission.run(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
        }));
        await Promise.all(runs);
        expect(peak).toBe(2);
        expect(admission.inspect()).toEqual({ active: 0, queued: 0 });
    });

    it('sheds before dispatch once the queue is full rather than queueing forever', async () => {
        const admission = createPasswordHashAdmission({ maxConcurrent: 1, maxQueued: 1 });
        let releaseFirst = () => {};
        const first = admission.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
        await new Promise((resolve) => setImmediate(resolve));

        let dispatched = false;
        const queued = admission.run(async () => { dispatched = true; });
        // The third arrival has nowhere to wait: scrypt cannot be cancelled, so
        // admitting it would only add unbounded latency and memory.
        await expect(admission.run(async () => 'never')).rejects.toBeInstanceOf(PasswordHashOverloadedError);
        expect(dispatched).toBe(false);

        releaseFirst();
        await first;
        await queued;
        expect(dispatched).toBe(true);
        expect(admission.inspect()).toEqual({ active: 0, queued: 0 });
    });

    it('releases its slot when the work throws', async () => {
        const admission = createPasswordHashAdmission({ maxConcurrent: 1, maxQueued: 0 });
        await expect(admission.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(admission.inspect()).toEqual({ active: 0, queued: 0 });
        await expect(admission.run(async () => 'ok')).resolves.toBe('ok');
    });

    it('reserves a released slot for queued work before a new arrival can take it', async () => {
        const admission = createPasswordHashAdmission({ maxConcurrent: 1, maxQueued: 2 });
        let finish = () => {};
        const gate = new Promise<void>((resolve) => { finish = resolve; });
        const first = admission.run(() => gate);
        let finishQueued = () => {};
        const queued = admission.run(() => new Promise<void>((resolve) => { finishQueued = resolve; }));
        // This arrival is already in the microtask queue when the released
        // waiter resumes, reproducing admission during slot handoff.
        let arrivalDispatched = false;
        const arrival = gate.then(() => admission.run(async () => { arrivalDispatched = true; }));
        finish();
        await first;
        const stateDuringQueuedWork = admission.inspect();
        const dispatchedDuringQueuedWork = arrivalDispatched;
        finishQueued();
        await Promise.all([queued, arrival]);
        expect(stateDuringQueuedWork).toEqual({ active: 1, queued: 1 });
        expect(dispatchedDuringQueuedWork).toBe(false);
    });

    it('routes real and dummy password work through the same shared bound', async () => {
        const admission = passwordHashAdmission();
        const pending = [
            hashPasswordMaterial(utf8(PASSWORD)),
            performDummyPasswordWork(),
            performDummyPasswordWork(),
        ];
        // Dummy work must contend for the same slots; otherwise a flood of
        // unknown-Account attempts walks straight past load shedding.
        const admitted = admission.inspect().active + admission.inspect().queued;
        await Promise.all(pending);
        expect(admitted).toBe(3);
        expect(admission.inspect()).toEqual({ active: 0, queued: 0 });
    });
});
