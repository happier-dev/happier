import { vi } from 'vitest';

/** JSDOM provides layout APIs but has no font or graphics device. */
export function installFirstOpenWebGraphics(width: number, height: number, onDraw = () => {}) {
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load: async () => [] } });
    const noop = () => {};
    const handle = () => ({});
    const yes = () => true;
    const gl = {
        isContextLost: () => false, getExtension: () => null,
        createProgram: handle, createShader: handle, createBuffer: handle,
        createTexture: handle, createVertexArray: handle, getUniformLocation: handle,
        getProgramParameter: yes, getShaderParameter: yes,
        activeTexture: noop, attachShader: noop, bindBuffer: noop, bindTexture: noop,
        bindVertexArray: noop, blendFuncSeparate: noop, bufferData: noop,
        clear: noop, clearColor: noop, compileShader: noop, deleteBuffer: noop,
        deleteProgram: noop, deleteShader: noop, deleteTexture: noop, deleteVertexArray: noop,
        drawArrays: onDraw, drawArraysInstanced: onDraw, enable: noop, enableVertexAttribArray: noop,
        linkProgram: noop, shaderSource: noop, texImage2D: noop, texParameteri: noop,
        texSubImage2D: noop, uniform1i: noop, uniform2f: noop, uniform3f: noop, useProgram: noop,
        vertexAttribDivisor: noop, vertexAttribPointer: noop, viewport: noop,
    };
    const context2d = {
        fillText: noop, clearRect: noop,
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
        }),
    };
    // These partial contexts implement the browser calls exercised by the real glyph painter.
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        ((kind: string) => {
            if (kind === 'webgl2') return gl;
            if (kind === '2d') return context2d;
            return null;
        }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    // React Native Web reads document layout to size each production surface.
    const viewportWidth = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width);
    const viewportHeight = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(height);
    window.dispatchEvent(new Event('resize'));
    document.dispatchEvent(new Event('visibilitychange'));
    return () => {
        canvas.mockRestore();
        visibility.mockRestore();
        viewportWidth.mockRestore();
        viewportHeight.mockRestore();
        if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
        else Reflect.deleteProperty(document, 'fonts');
    };
}
