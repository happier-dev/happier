import 'react-test-renderer';

declare module 'react-test-renderer' {
    interface ReactTestInstance {
        findByType(type: string): ReactTestInstance;
        findAllByType(type: string, options?: { deep: boolean }): ReactTestInstance[];
    }
}
