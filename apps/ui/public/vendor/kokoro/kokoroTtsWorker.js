import { KokoroTTS, TextSplitterStream, env } from './kokoro.web.js'

function clampSample(x) {
    if (x > 1) return 1
    if (x < -1) return -1
    return x
}

function floatToPcm16(x) {
    const clamped = clampSample(x)
    if (clamped <= -1) return -32768
    if (clamped >= 1) return 32767
    return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
}

function encodeWavPcm16(samples, sampleRate) {
    const numChannels = 1
    const bytesPerSample = 2
    const blockAlign = numChannels * bytesPerSample
    const byteRate = sampleRate * blockAlign
    const dataSize = samples.length * bytesPerSample

    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)
    const u8 = new Uint8Array(buffer)

    const writeAscii = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) {
            u8[offset + index] = text.charCodeAt(index) & 0xff
        }
    }

    writeAscii(0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeAscii(8, 'WAVE')

    writeAscii(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, numChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, byteRate, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, 16, true)

    writeAscii(36, 'data')
    view.setUint32(40, dataSize, true)

    let cursor = 44
    for (let index = 0; index < samples.length; index += 1) {
        view.setInt16(cursor, floatToPcm16(samples[index] ?? 0), true)
        cursor += 2
    }

    return buffer
}

function resolveWasmPaths(cfg) {
    if (typeof cfg?.wasmPaths === 'string' && cfg.wasmPaths.trim().length > 0) {
        return cfg.wasmPaths.trim()
    }
    return '/vendor/kokoro/onnxruntime-web/'
}

let cachedRuntimeKey = null
let cachedTtsPromise = null

function resolveRuntimeKey(cfg) {
    return `${cfg?.modelId ?? ''}|${cfg?.dtype ?? ''}|${cfg?.device ?? ''}|${resolveWasmPaths(cfg)}`
}

async function getTts(cfg, progressCallback) {
    const nextKey = resolveRuntimeKey(cfg)
    if (cachedTtsPromise && cachedRuntimeKey === nextKey) {
        return await cachedTtsPromise
    }

    cachedRuntimeKey = nextKey
    cachedTtsPromise = (async () => {
        env.wasmPaths = resolveWasmPaths(cfg)
        return await KokoroTTS.from_pretrained(cfg.modelId, {
            dtype: cfg.dtype,
            device: cfg.device,
            progress_callback: progressCallback,
        })
    })().catch((error) => {
        cachedRuntimeKey = null
        cachedTtsPromise = null
        throw error
    })

    return await cachedTtsPromise
}

const canceledRequestIds = new Set()
const activeSplittersByRequestId = new Map()

function postProgress(id, progress) {
    globalThis.postMessage({ id, type: 'progress', progress })
}

function postResult(id, wavBytes) {
    globalThis.postMessage({ id, type: 'result', wavBytes }, [wavBytes])
}

function postStreamChunk(id, wavBytes, sentenceText) {
    globalThis.postMessage({ id, type: 'stream_chunk', wavBytes, sentenceText }, [wavBytes])
}

function postStreamEnd(id) {
    globalThis.postMessage({ id, type: 'stream_end' })
}

function postError(id, error) {
    const message = error instanceof Error ? error.message : String(error)
    globalThis.postMessage({ id, type: 'error', message })
}

function extractRawAudio(audioObj) {
    const samples = audioObj?.audio
    const sampleRate = audioObj?.sampling_rate

    if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate)) {
        throw new Error('kokoro_invalid_audio_chunk')
    }

    return {
        samples,
        sampleRate,
    }
}

async function handlePrepare(message) {
    await getTts(message.cfg, (progress) => postProgress(message.id, progress))
    if (canceledRequestIds.has(message.id)) return
    postResult(message.id, new ArrayBuffer(0))
}

async function handleGenerate(message) {
    const tts = await getTts(message.cfg, (progress) => postProgress(message.id, progress))
    if (canceledRequestIds.has(message.id)) return

    const audioObj = await tts.generate(message.text, {
        voice: message.voiceId,
        speed: message.speed,
    })
    if (canceledRequestIds.has(message.id)) return

    const { samples, sampleRate } = extractRawAudio(audioObj)
    const wavBytes = encodeWavPcm16(samples, sampleRate)
    if (canceledRequestIds.has(message.id)) return

    postResult(message.id, wavBytes)
}

async function handleStream(message) {
    if (typeof TextSplitterStream !== 'function') {
        throw new Error('kokoro_streaming_not_supported')
    }

    const tts = await getTts(message.cfg, (progress) => postProgress(message.id, progress))
    if (canceledRequestIds.has(message.id)) return

    const splitter = new TextSplitterStream()
    activeSplittersByRequestId.set(message.id, splitter)

    try {
        const stream = tts.stream(splitter, {
            voice: message.voiceId,
            speed: message.speed,
        })

        splitter.push(message.text)
        splitter.close()

        for await (const chunk of stream) {
            if (canceledRequestIds.has(message.id)) return

            const sentenceText = typeof chunk?.text === 'string' ? chunk.text : ''
            const audioObj = chunk?.audio
            const { samples, sampleRate } = extractRawAudio(audioObj)
            const wavBytes = encodeWavPcm16(samples, sampleRate)
            if (canceledRequestIds.has(message.id)) return
            postStreamChunk(message.id, wavBytes, sentenceText)
        }

        if (canceledRequestIds.has(message.id)) return
        postStreamEnd(message.id)
    } finally {
        activeSplittersByRequestId.delete(message.id)
    }
}

globalThis.onmessage = async (event) => {
    const message = event?.data
    if (!message || typeof message !== 'object') return

    if (message.type === 'cancel') {
        canceledRequestIds.add(message.id)
        const splitter = activeSplittersByRequestId.get(message.id)
        try {
            splitter?.close?.()
        } catch {
            // ignore
        }
        activeSplittersByRequestId.delete(message.id)
        return
    }

    canceledRequestIds.delete(message.id)

    try {
        if (message.type === 'prepare') {
            await handlePrepare(message)
            return
        }
        if (message.type === 'generate') {
            await handleGenerate(message)
            return
        }
        if (message.type === 'stream') {
            await handleStream(message)
            return
        }
        throw new Error(`kokoro_unknown_worker_message:${String(message.type ?? '')}`)
    } catch (error) {
        if (canceledRequestIds.has(message.id)) return
        postError(message.id, error)
    } finally {
        if (message.type !== 'cancel') {
            canceledRequestIds.delete(message.id)
            activeSplittersByRequestId.delete(message.id)
        }
    }
}
