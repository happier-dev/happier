export function setStdioTtyForTest(params: Readonly<{ stdin: boolean; stdout: boolean }>): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

  Object.defineProperty(process.stdin, 'isTTY', { value: params.stdin, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: params.stdout, configurable: true })

  return () => {
    if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
    else delete (process.stdin as { isTTY?: boolean }).isTTY

    if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
}
