import ExpoModulesCore

/**
 Expo entrypoint for the one token-scoped hosted-web Artifact frame. The
 registry remains the native consumer of opaque Artifact cache coordinates;
 this module deliberately has no URL, byte, or cache-path API.
 */
public final class HappierHostedWebFrameModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierHostedWebFrame")

    // The strict typed admission result, identical in shape to Android/JS. iOS
    // has no profile-isolation capability class, so it reports only the two
    // outcomes its registry can produce.
    AsyncFunction("registerArtifact") { (input: [String: Any]) -> [String: Any] in
      if HostedWebArtifactRegistryOwner.shared.register(input) {
        return ["kind": "registered"]
      }
      return [
        "kind": "unavailable",
        "code": "native_artifact_resource_registration_failed",
      ]
    }

    // This is intentionally a synchronous acknowledgement. Artifact keeps its
    // handle/cache index until the native registry rejects later reads.
    Function("unregisterArtifact") { (token: String) -> Bool in
      HostedWebArtifactRegistryOwner.shared.unregister(token)
    }

    View(HostedWebArtifactView.self) {
      Events("onMessage", "onLoadStart", "onLoadEnd", "onLoadError", "onExternalNavigation", "onBlockedNavigation", "onHistoryStateChange")

      Prop("title") { (view: HostedWebArtifactView, title: String?) in
        view.setTitle(title)
      }
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
