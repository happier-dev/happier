import ExpoModulesCore

/**
 Expo entrypoint for the one token-scoped hosted-web Artifact frame. The
 registry remains the native consumer of opaque Artifact cache coordinates;
 this module deliberately has no URL, byte, or cache-path API.
 */
public final class HappierHostedWebFrameModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierHostedWebFrame")

    AsyncFunction("registerArtifact") { (input: [String: Any]) -> Bool in
      HostedWebArtifactRegistryOwner.shared.register(input)
    }

    // This is intentionally a synchronous acknowledgement. Artifact keeps its
    // handle/cache index until the native registry rejects later reads.
    Function("unregisterArtifact") { (token: String) -> Bool in
      HostedWebArtifactRegistryOwner.shared.unregister(token)
    }

    View(HostedWebArtifactView.self) {
      Events("onMessage", "onLoadStart", "onLoadEnd", "onLoadError", "onExternalNavigation", "onBlockedNavigation", "onHistoryStateChange")

      Prop("artifactHandleToken") { (view: HostedWebArtifactView, token: String?) in
        view.setArtifactHandleToken(token)
      }
      Prop("initialPathAndQuery") { (view: HostedWebArtifactView, pathAndQuery: String?) in
        view.setInitialPathAndQuery(pathAndQuery)
      }
      Prop("allowedNavigationOrigins") { (view: HostedWebArtifactView, origins: [String]) in
        view.setAllowedNavigationOrigins(origins)
      }

      // Expo view AsyncFunctions live on the view ref and execute on the main
      // queue. The JS component invokes this only while its host bridge is
      // mounted; the view independently verifies its token and active origin.
      AsyncFunction("postHostMessage") { (view: HostedWebArtifactView, serializedMessage: String) -> Bool in
        view.postHostMessage(serializedMessage)
      }
      AsyncFunction("goBack") { (view: HostedWebArtifactView) -> Bool in
        view.goBack()
      }
    }

    OnDestroy {
      HostedWebArtifactRegistryOwner.shared.clear()
    }
  }
}
