import React from 'react'

function App(): JSX.Element {
  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <header className="text-2xl font-semibold text-gray-900 mb-4">Tailwind Prod Starter</header>
      <main className="prose color" style={{ maxWidth: '60ch' }}>
        <p>This is a lightweight production-ready React + Tailwind starter.</p>
        <p>Customize Tailwind and modern tooling to fit your project.</p>
      </main>
    </div>
  )
}

export default App
