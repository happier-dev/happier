// kokoro-js 1.2.1's bundled eSpeak bootstrap iterates a ReadableStream directly.
// Response consumes the same gzip output on browsers that expose stream readers
// without async iteration. Remove this rewrite when the upstream bootstrap does so.
export function prepareKokoroWebRuntime(source) {
    const legacy = ',t=[];for await(const e of A)t.push(e);const r=await new Blob(t).arrayBuffer();';
    const corrected = ';const r=await new Response(A).arrayBuffer();';
    if (source.includes(legacy)) return source.replace(legacy, corrected);
    if (source.includes(corrected)) return source;
    throw new Error('Kokoro web phonemizer bootstrap changed; verify stream compatibility before vendoring');
}
