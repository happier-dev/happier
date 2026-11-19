import { glyphDotRadii, type GlyphFrame, type GlyphGrid } from '@happier-dev/brand/glyph-scene';

import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';

import { glyphAtlas } from './glyphAtlas.web';
import { glyphAtlasChars, glyphAtlasColumns, packGlyphAtlas } from './glyphAtlasLayout';

const spriteVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 centre;
layout(location=1) in float glyph;
layout(location=2) in vec4 colour;
uniform vec2 size;
uniform vec2 cell;
out vec2 uv;
out vec4 ink;
out vec2 pixel;
void main() {
    vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
    vec2 point = centre + (corner - 0.5) * cell;
    gl_Position = vec4(point / size * vec2(2., -2.) + vec2(-1., 1.), 0., 1.);
    uv = vec2((glyph + corner.x) / ${glyphAtlasColumns}.0, corner.y);
    ink = colour;
    pixel = point;
}`;
const spriteFragment = `#version 300 es
precision highp float;
in vec2 uv;
in vec4 ink;
in vec2 pixel;
uniform sampler2D atlas;
uniform sampler2D mask;
uniform vec2 maskExtent;
uniform bool isField;
out vec4 colour;
void main() {
    float veil = isField ? texture(mask, pixel / maskExtent).a : 1.;
    colour = vec4(ink.rgb, ink.a * texture(atlas, uv).a * veil);
}`;
const bodyVertex = `#version 300 es
precision highp float;
out vec2 point;
uniform vec2 size;
void main() {
    point = vec2(gl_VertexID & 1, gl_VertexID >> 1) * size;
    gl_Position = vec4(point / size * vec2(2., -2.) + vec2(-1., 1.), 0., 1.);
}`;
const bodyFragment = `#version 300 es
precision highp float;
in vec2 point;
uniform vec2 textureSizePx;
uniform vec3 disc;
uniform sampler2D body;
uniform sampler2D foot;
uniform vec2 footSize;
out vec4 colour;
void main() {
    vec4 c = texture(body, point / textureSizePx);
    float limb = 1. - smoothstep(disc.z - 0.5, disc.z + 0.5, distance(point, disc.xy));
    float fade = texture(foot, vec2(fract(point.x / footSize.x), point.y / footSize.y)).a;
    colour = vec4(c.rgb, c.a * limb * fade);
}`;

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
    const program = gl.createProgram();
    if (!program) return null;
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) {
            gl.deleteProgram(program);
            return null;
        }
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
        const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
        gl.deleteShader(shader);
        if (!compiled) {
            gl.deleteProgram(program);
            return null;
        }
    }
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
    gl.deleteProgram(program);
    return null;
}

type Atlas = ReturnType<typeof packGlyphAtlas>;
export async function warmWebGlyphAtlas(grid: GlyphGrid, dpr: number): Promise<Atlas> {
    const [w, h] = grid.cell;
    const [regular, small] = await Promise.all([
        glyphAtlas({ w: w / dpr, h: h / dpr, chars: glyphAtlasChars }, dpr),
        glyphAtlas({ w: w * 0.75 / dpr, h: h * 0.625 / dpr, chars: glyphAtlasChars }, dpr),
    ]);
    return packGlyphAtlas(grid, regular, small, dpr);
}

function upload(gl: WebGL2RenderingContext, texture: WebGLTexture | null, unit: number, width: number, height: number, bytes: Uint8Array | Uint8ClampedArray, linear = false) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
}

const opaque = new Uint8Array([255, 255, 255, 255]);

function preparePrograms(gl: WebGL2RenderingContext) {
    const sprite = createProgram(gl, spriteVertex, spriteFragment);
    const body = createProgram(gl, bodyVertex, bodyFragment);
    if (!sprite || !body) {
        gl.deleteProgram(sprite);
        gl.deleteProgram(body);
        return null;
    }
    const uniforms = (program: WebGLProgram, names: readonly string[]) =>
        Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
    const spriteUniform = uniforms(sprite, ['size', 'cell', 'atlas', 'mask', 'maskExtent', 'isField']);
    const bodyUniform = uniforms(body, ['size', 'textureSizePx', 'disc', 'body', 'foot', 'footSize']);

    const bodyTexture = gl.createTexture(), footTexture = gl.createTexture(), atlasTexture = gl.createTexture();
    const fieldTexture = gl.createTexture();
    upload(gl, fieldTexture, 3, 1, 1, opaque);
    const bodyVao = gl.createVertexArray();
    function batch() {
        const vao = gl.createVertexArray();
        const buffers = [gl.createBuffer(), gl.createBuffer(), gl.createBuffer()];
        gl.bindVertexArray(vao);
        for (const [index, elements, type, normalized] of [[0, 2, gl.UNSIGNED_SHORT, false], [1, 1, gl.UNSIGNED_BYTE, false], [2, 4, gl.UNSIGNED_BYTE, true]] as const) {
            gl.bindBuffer(gl.ARRAY_BUFFER, buffers[index]);
            gl.enableVertexAttribArray(index);
            gl.vertexAttribPointer(index, elements, type, normalized, 0, 0);
            gl.vertexAttribDivisor(index, 1);
        }
        return { vao, buffers };
    }
    const dynamic = batch(), stipple = batch();
    let uploadedStipple: GlyphFrame['sprites'] | undefined;
    let fieldRevision = -1;
    function drawSprites(frame: GlyphFrame, atlas: Atlas, field: GlyphFrame['field']) {
        const sprites = field?.sprites ?? frame.sprites;
        if (sprites.glyph.length === 0) return;
        gl.useProgram(sprite);
        const { vao, buffers } = field ? stipple : dynamic;
        gl.bindVertexArray(vao);
        gl.uniform2f(spriteUniform.size, frame.width, frame.height);
        gl.uniform2f(spriteUniform.cell, frame.grid.cell[0], frame.grid.cell[1]);
        if (uploadedAtlas !== atlas) {
            upload(gl, atlasTexture, 0, atlas.width, atlas.height, atlas.pixels);
            uploadedAtlas = atlas;
        }
        gl.uniform1i(spriteUniform.atlas, 0);
        gl.uniform1i(spriteUniform.mask, 3);
        gl.uniform1i(spriteUniform.isField, field ? 1 : 0);
        if (field) {
            gl.uniform2f(spriteUniform.maskExtent, ...field.maskExtent);
            if (uploadedFieldWidth !== field.mask.width || uploadedFieldHeight !== field.mask.height) {
                upload(gl, fieldTexture, 3, field.mask.width, field.mask.height, field.mask.rgba, true);
                uploadedFieldWidth = field.mask.width;
                uploadedFieldHeight = field.mask.height;
            } else if (uploadedStipple !== sprites || fieldRevision !== field.revision) {
                gl.activeTexture(gl.TEXTURE3);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, field.mask.width, field.mask.height, gl.RGBA, gl.UNSIGNED_BYTE, field.mask.rgba);
            }
            fieldRevision = field.revision;
        }
        if (!field || uploadedStipple !== sprites) {
            const fields = [sprites.at, sprites.glyph, sprites.rgba];
            for (let i = 0; i < fields.length; i++) {
                gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i]);
                gl.bufferData(gl.ARRAY_BUFFER, fields[i], field ? gl.STATIC_DRAW : gl.STREAM_DRAW);
            }
            if (field) uploadedStipple = sprites;
        }
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sprites.glyph.length);
    }
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let uploadedBody: GlyphFrame['body'];
    let uploadedFieldWidth = 1, uploadedFieldHeight = 1;
    let uploadedFoot: NonNullable<GlyphFrame['body']>['fadeMask'];
    let uploadedAtlas: Atlas | undefined;
    return {
        paint(frame: GlyphFrame, atlas: Atlas) {
            const { width, height, grid, field, body: disc } = frame;
            gl.viewport(0, 0, width, height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            if (field) drawSprites(frame, atlas, field);
            if (disc) {
                gl.useProgram(body);
                gl.bindVertexArray(bodyVao);
                gl.uniform2f(bodyUniform.size, width, height);
                gl.uniform2f(bodyUniform.textureSizePx, grid.cell[0] * disc.cols, grid.cell[1] * disc.rows);
                gl.uniform3f(bodyUniform.disc, disc.disc.cx, disc.disc.cy, disc.disc.R);
                if (uploadedBody !== disc) {
                    if (uploadedBody?.cols === disc.cols && uploadedBody.rows === disc.rows) {
                        gl.activeTexture(gl.TEXTURE1);
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, disc.cols, disc.rows, gl.RGBA, gl.UNSIGNED_BYTE, disc.rgba);
                    } else {
                        upload(gl, bodyTexture, 1, disc.cols, disc.rows, disc.rgba, true);
                    }
                    uploadedBody = disc;
                }
                if (uploadedFoot !== disc.fadeMask) {
                    upload(gl, footTexture, 2, disc.fadeMask?.width ?? 1, disc.fadeMask?.height ?? 1, disc.fadeMask?.rgba ?? opaque);
                    uploadedFoot = disc.fadeMask;
                }
                gl.uniform2f(bodyUniform.footSize, disc.fadeMask?.width ?? 1, disc.fadeMask?.height ?? height);
                gl.uniform1i(bodyUniform.body, 1);
                gl.uniform1i(bodyUniform.foot, 2);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
            drawSprites(frame, atlas, null);
        },
        dispose() {
            gl.deleteTexture(atlasTexture);
            gl.deleteTexture(bodyTexture);
            gl.deleteTexture(footTexture);
            gl.deleteTexture(fieldTexture);
            for (const { buffers, vao } of [dynamic, stipple]) {
                for (const buffer of buffers) gl.deleteBuffer(buffer);
                gl.deleteVertexArray(vao);
            }
            gl.deleteVertexArray(bodyVao);
            gl.deleteProgram(sprite);
            gl.deleteProgram(body);
        },
    };
}

export function createWebGlyphPainter(canvas: HTMLCanvasElement, onLost: () => void, onRestored: (ready: boolean) => void) {
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true, depth: false, antialias: false });
    let resources = gl && !gl.isContextLost() ? preparePrograms(gl) : null;
    let lost = 0;
    const handleLoss = (event: Event) => { event.preventDefault(); lost++; resources = null; onLost(); };
    const handleRestore = () => { resources = gl && preparePrograms(gl); onRestored(resources !== null); };
    canvas.addEventListener('webglcontextlost', handleLoss);
    canvas.addEventListener('webglcontextrestored', handleRestore);
    if (gl?.isContextLost()) gl.getExtension('WEBGL_lose_context')?.restoreContext();
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
        get ready() { return resources !== null; },
        get lost() { return lost; },
        renderer: info ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null,
        paint(frame: GlyphFrame, atlas: Atlas) { resources?.paint(frame, atlas); },
        dispose(release: () => boolean) {
            canvas.removeEventListener('webglcontextlost', handleLoss);
            canvas.removeEventListener('webglcontextrestored', handleRestore);
            resources?.dispose();
            releaseCanvasBackingStore(canvas);
            // Activity and StrictMode can replay setup for the same DOM canvas.
            queueMicrotask(() => { if (release()) releaseCanvasBackingStore(canvas, gl); });
        },
    };
}

export function paintWebStill(canvas: HTMLCanvasElement, frame: GlyphFrame, atlas: Atlas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, frame.width, frame.height);
    const scratch = document.createElement('canvas');
    const context = scratch.getContext('2d');
    if (!context) return;
    const { body, field, sprites, grid } = frame;
    const [w, h] = grid.cell;
    if (field) {
        const { mask, maskExtent } = field;
        const dots = field.sprites;
        for (let i = 0; i < dots.glyph.length; i++) {
            const x = dots.at[i * 2], y = dots.at[i * 2 + 1];
            const column = Math.min(mask.width - 1, Math.floor(x * mask.width / maskExtent[0]));
            const row = Math.min(mask.height - 1, Math.floor(y * mask.height / maskExtent[1]));
            ctx.fillStyle = `rgba(${dots.rgba[i * 4]}, ${dots.rgba[i * 4 + 1]}, ${dots.rgba[i * 4 + 2]}, ${mask.rgba[(row * mask.width + column) * 4 + 3] / 255})`;
            ctx.beginPath();
            ctx.arc(x, y, glyphDotRadii[dots.glyph[i] - 21] * h / 16, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    if (body) {
        const bodyCanvas = document.createElement('canvas');
        bodyCanvas.width = frame.width;
        bodyCanvas.height = frame.height;
        const bodyContext = bodyCanvas.getContext('2d');
        if (!bodyContext) return;
        scratch.width = body.cols;
        scratch.height = body.rows;
        context.putImageData(new ImageData(new Uint8ClampedArray(body.rgba), body.cols, body.rows), 0, 0);
        bodyContext.save();
        bodyContext.beginPath();
        bodyContext.arc(body.disc.cx, body.disc.cy, body.disc.R, 0, Math.PI * 2);
        bodyContext.clip();
        bodyContext.drawImage(scratch, 0, 0, body.cols * grid.cell[0], body.rows * grid.cell[1]);
        bodyContext.restore();
        if (body.fadeMask) {
            const mask = body.fadeMask;
            scratch.width = mask.width;
            scratch.height = mask.height;
            context.putImageData(new ImageData(new Uint8ClampedArray(mask.rgba), mask.width, mask.height), 0, 0);
            bodyContext.globalCompositeOperation = 'destination-in';
            bodyContext.fillStyle = bodyContext.createPattern(scratch, 'repeat-x') ?? '#fff';
            bodyContext.fillRect(0, 0, frame.width, frame.height);
        }
        ctx.drawImage(bodyCanvas, 0, 0);
        releaseCanvasBackingStore(bodyCanvas);
    }

    scratch.width = w;
    scratch.height = h;
    const tile = context.createImageData(w, h);
    for (let i = 0; i < sprites.glyph.length; i++) {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const pixel = (y * w + x) * 4;
                const source = (y * atlas.width + sprites.glyph[i] * w + x) * 4;
                tile.data[pixel] = sprites.rgba[i * 4];
                tile.data[pixel + 1] = sprites.rgba[i * 4 + 1];
                tile.data[pixel + 2] = sprites.rgba[i * 4 + 2];
                tile.data[pixel + 3] = atlas.pixels[source + 3] * sprites.rgba[i * 4 + 3] / 255;
            }
        }
        context.putImageData(tile, 0, 0);
        ctx.drawImage(scratch, sprites.at[i * 2] - w / 2, sprites.at[i * 2 + 1] - h / 2);
    }
    releaseCanvasBackingStore(scratch);
}
