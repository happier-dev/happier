type WritableGlobal = typeof globalThis & {
    DOMException?: typeof DOMException;
};

class HappierDOMException extends Error {
    constructor(message = '', name = 'Error') {
        super(message);
        this.name = name;
    }
}

function installDOMException(): void {
    const target = globalThis as WritableGlobal;
    if (typeof target.DOMException === 'function') {
        return;
    }

    Object.defineProperty(target, 'DOMException', {
        value: HappierDOMException,
        configurable: true,
        writable: true,
    });
}

installDOMException();
